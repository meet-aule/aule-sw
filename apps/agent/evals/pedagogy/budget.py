"""Admission control shared by tutor, judge and safety calls (USD list prices).

Reservations are fsynced before sending. An interrupted/ambiguous request keeps
its full reservation. Resume replays the journal; it never resets the allowance.
"""

import fcntl
import json
import os
from pathlib import Path

import httpx2 as httpx

PRICES = {
    # input, output, 5-minute cache creation, cache read, maximum cache write
    "claude-sonnet-5-5": (2.0, 10.0, 2.5, 0.1, 4.0),
    "claude-haiku-5-5": (0.1, 0.5, 0.125, 0.01, 0.2),
}


class BudgetExceeded(RuntimeError):
    pass


def price(model, usage):
    base, output, creation, read, _ = PRICES[model]
    return (
        usage.get("input_tokens", 0) * base
        + usage.get("output_tokens", 0) * output
        + usage.get("cache_creation_input_tokens", 0) * creation
        + usage.get("cache_read_input_tokens", 0) * read
    ) / 1_000_000


def stream_usage(raw):
    usage = {}
    complete = False
    for line in raw.splitlines():
        if not line.startswith(b"data: "):
            continue
        event = json.loads(line[6:])
        if event.get("type") == "message_start":
            usage.update(event["message"]["usage"])
        elif event.get("type") == "message_delta":
            # Anthropic deltas report cumulative output tokens, not increments.
            usage.update(event.get("usage", {}))
        elif event.get("type") == "message_stop":
            complete = True
    return usage if complete else None


class Budget:
    def __init__(self, path: Path, cap: float):
        if not 0 < cap <= 20:
            raise ValueError("budget must be greater than zero and at most USD 20")
        path.parent.mkdir(parents=True, exist_ok=True)
        self.file = path.open("a+", encoding="utf-8")
        fcntl.flock(self.file, fcntl.LOCK_EX | fcntl.LOCK_NB)
        self.cap = cap
        self.calls = {}
        self.file.seek(0)
        rows = [json.loads(line) for line in self.file]
        if rows:
            if rows[0] != {"type": "budget", "cap": cap, "prices": PRICES_JSON}:
                raise ValueError("budget or price schedule differs from the existing journal")
            for row in rows[1:]:
                if row["type"] == "reserve":
                    self.calls[row["id"]] = row
                elif row["type"] == "settle":
                    self.calls[row["id"]].update(row)
        else:
            self.write({"type": "budget", "cap": cap, "prices": PRICES_JSON})

    def write(self, row):
        self.file.write(json.dumps(row, ensure_ascii=False) + "\n")
        self.file.flush()
        os.fsync(self.file.fileno())

    @property
    def committed(self):
        return sum(row.get("usd", row["reserved_usd"]) for row in self.calls.values())

    def reserve(self, provider, model, bound, label):
        if bound < 0 or self.committed + bound > self.cap:
            raise BudgetExceeded("insufficient remaining allowance for this request")
        key = len(self.calls) + 1
        row = dict(
            type="reserve", id=key, provider=provider, model=model, reserved_usd=bound, label=label
        )
        self.write(row)
        self.calls[key] = row
        return key

    def settle(self, key, usd, usage):
        if usd < 0 or usd > self.calls[key]["reserved_usd"] + 1e-9:
            raise RuntimeError("reported usage exceeded reservation; stop the experiment")
        row = dict(type="settle", id=key, usd=usd, usage=usage)
        self.write(row)
        self.calls[key].update(row)

    def summary(self):
        actual = [r for r in self.calls.values() if "usd" in r]
        uncertain = [r for r in self.calls.values() if "usd" not in r]
        return {
            "cap_usd": self.cap,
            "calls": len(self.calls),
            "usage_based_estimate_usd": sum(r["usd"] for r in actual),
            "unreconciled_upper_bound_usd": sum(r["reserved_usd"] for r in uncertain),
            "committed_upper_bound_usd": self.committed,
            "remaining_usd": self.cap - self.committed,
            "unreconciled_calls": len(uncertain),
        }

    def close(self):
        self.file.close()


PRICES_JSON = json.loads(json.dumps(PRICES))


class MeteredTransport(httpx.AsyncBaseTransport):
    """Buffer tiny text responses to account for usage before returning them.

    This deliberately measures whole-turn latency, not streaming first-token
    latency. Only Anthropic Messages is admitted. No unmetered API fallback.
    """

    def __init__(self, budget, label):
        self.budget, self.label = budget, label
        self.inner = httpx.AsyncHTTPTransport(retries=0)

    async def handle_async_request(self, request):
        if request.url.host != "api.anthropic.com" or request.url.path != "/v1/messages":
            raise ValueError("only the metered Anthropic Messages endpoint is allowed")
        raw_request = await request.aread()
        payload = json.loads(raw_request)
        model = payload["model"]
        rates = PRICES[model]  # Unknown price: fail before sending.
        if len(raw_request) + 8192 > 90_000 or payload["max_tokens"] > 2048:
            raise ValueError("request exceeds the evaluation's token/byte ceiling")
        # One token per UTF-8 byte plus framing headroom; cache writes use the
        # highest rate. The harness sends only text and ephemeral 5m caches.
        bound = (
            (len(raw_request) + 8192) * rates[4] + payload["max_tokens"] * rates[1]
        ) / 1_000_000
        key = self.budget.reserve("anthropic", model, bound, self.label)
        response = await self.inner.handle_async_request(request)
        try:
            raw = await response.aread()
            if response.status_code == 200:
                usage = stream_usage(raw) if payload.get("stream") else json.loads(raw).get("usage")
                if usage is not None:
                    self.budget.settle(key, price(model, usage), usage)
            return httpx.Response(
                response.status_code,
                headers={
                    k: v
                    for k, v in response.headers.items()
                    if k.lower() not in ("content-encoding", "content-length")
                },
                content=raw,
                extensions=response.extensions,
            )
        finally:
            await response.aclose()

    async def aclose(self):
        await self.inner.aclose()
