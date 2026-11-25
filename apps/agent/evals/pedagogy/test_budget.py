import json

import httpx2 as httpx
import pytest
from budget import Budget, BudgetExceeded, MeteredTransport, stream_usage
from cases import cases


def test_resume_keeps_unknown_usage_and_prevents_overspend(tmp_path):
    path = tmp_path / "ledger"
    budget = Budget(path, 1)
    first = budget.reserve("anthropic", "test", 0.6, "first")
    budget.settle(first, 0.2, {"output_tokens": 1})
    budget.reserve("anthropic", "test", 0.7, "timed-out")
    budget.close()
    resumed = Budget(path, 1)
    assert resumed.committed == pytest.approx(0.9)
    with pytest.raises(BudgetExceeded):
        resumed.reserve("anthropic", "test", 0.11, "denied")
    assert len(resumed.calls) == 2
    resumed.close()


def test_cannot_raise_ceiling_on_resume(tmp_path):
    path = tmp_path / "ledger"
    Budget(path, 1).close()
    with pytest.raises(ValueError):
        Budget(path, 2)
    with pytest.raises(ValueError):
        Budget(tmp_path / "too-much", 20.01)


def test_stream_requires_completed_usage_and_deltas_are_cumulative():
    events = [
        {"type": "message_start", "message": {"usage": {"input_tokens": 8, "output_tokens": 1}}},
        {"type": "message_delta", "usage": {"output_tokens": 10}},
    ]

    def encode(rows):
        return b"\n".join(b"data: " + json.dumps(r).encode() for r in rows)

    assert stream_usage(encode(events)) is None
    events.append({"type": "message_stop"})
    assert stream_usage(encode(events)) == {"input_tokens": 8, "output_tokens": 10}


@pytest.mark.asyncio
async def test_unknown_model_never_reaches_network(tmp_path):
    budget = Budget(tmp_path / "ledger", 20)
    transport = MeteredTransport(budget, "test")
    sent = []

    async def handler(request):
        sent.append(request)
        return httpx.Response(200, json={})

    await transport.inner.aclose()
    transport.inner = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as api:
        with pytest.raises(KeyError):
            await api.post(
                "https://api.anthropic.com/v1/messages", json={"model": "unknown", "max_tokens": 10}
            )
    assert not sent
    budget.close()


def test_fixed_cases_and_splits():
    dataset = cases()
    assert len(dataset) == len({c["id"] for c in dataset}) == 100
    assert {c["split"] for c in dataset} == {"development", "holdout"}
    assert all(c["answer"] != c["wrong"] and len(c["turns"]) == 3 for c in dataset)


@pytest.mark.asyncio
async def test_buffering_does_not_decompress_twice(tmp_path):
    import gzip

    budget = Budget(tmp_path / "ledger", 20)
    transport = MeteredTransport(budget, "test")
    await transport.inner.aclose()

    async def handler(request):
        body = json.dumps({"usage": {"input_tokens": 5, "output_tokens": 2}}).encode()
        return httpx.Response(
            200, headers={"content-encoding": "gzip"}, stream=httpx.ByteStream(gzip.compress(body))
        )

    transport.inner = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as api:
        response = await api.post(
            "https://api.anthropic.com/v1/messages",
            json={"model": "claude-sonnet-5-5", "max_tokens": 20},
        )
        assert response.json()["usage"]["output_tokens"] == 2
    assert budget.committed == pytest.approx(0.00003)
    assert budget.summary()["unreconciled_calls"] == 0
    budget.close()


@pytest.mark.asyncio
async def test_budget_denial_happens_before_network(tmp_path):
    budget = Budget(tmp_path / "ledger", 0.001)
    transport = MeteredTransport(budget, "test")
    sent = []
    await transport.inner.aclose()

    async def handler(request):
        sent.append(True)
        return httpx.Response(200, json={})

    transport.inner = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as api:
        with pytest.raises(BudgetExceeded):
            await api.post(
                "https://api.anthropic.com/v1/messages",
                json={"model": "claude-sonnet-5-5", "max_tokens": 20},
            )
    assert not sent
    assert budget.summary()["calls"] == 0
    budget.close()
