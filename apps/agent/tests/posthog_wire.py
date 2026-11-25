"""PostHog's requests, caught at the HTTP layer: what the production client
(``Observability.configured``) would send once the SDK has built each event,
run the allowlist on it, serialized and compressed it. Nothing connects
anywhere (``fakes.no_network``)."""

import contextlib
import gzip
import json
import threading
import zlib
from collections.abc import Iterator
from typing import Any

from fakes import no_network
from requests.adapters import HTTPAdapter
from requests.models import Response

# A synthetic project token, in the form config accepts.
TOKEN = "phc_" + "Synthetic0" * 4
POSTHOG_ENV = {"POSTHOG_API_KEY": TOKEN, "POSTHOG_HOST": "https://eu.i.posthog.com"}
ENDPOINT = "https://eu.i.posthog.com/i/v1/analytics/events"
EVENT_KEYS = {"event", "uuid", "distinct_id", "timestamp", "options", "properties"}
# What PostHog's SDK adds to an event, or a context of it would: none may leave.
SDK_KEYS = (
    "$lib",
    "$lib_version",
    "$os",
    "$os_version",
    "$os_distro",
    "$python_runtime",
    "$python_version",
    "$is_server",
    "$release_id",
    "$context_tags",
    "$session_id",
    "session_id",
    "$window_id",
    "$ai_session_id",
    "$set",
    "$set_once",
    "$groups",
    "$ip",
    "$current_url",
    "$ai_input",
    "$ai_output_choices",
)


class Wire:
    """Every request PostHog's client made, answered as PostHog would."""

    def __init__(self) -> None:
        self.requests: list[dict[str, Any]] = []
        self._lock = threading.Lock()

    def send(self, request: Any) -> Response:
        raw = request.body if isinstance(request.body, bytes) else (request.body or "").encode()
        encoding = request.headers.get("Content-Encoding")
        if encoding == "gzip":
            raw = gzip.decompress(raw)
        elif encoding == "deflate":
            raw = zlib.decompress(raw)
        elif encoding is not None:
            raise AssertionError(f"unexpected encoding {encoding}")
        body = json.loads(raw) if raw else {}
        with self._lock:
            self.requests.append(
                {
                    "method": request.method,
                    "url": request.url,
                    "headers": dict(request.headers),
                    "raw": raw.decode(),
                    "body": body,
                }
            )
        response = Response()
        response.status_code = 200
        response.request = request
        response.url = request.url
        response.headers["Content-Type"] = "application/json"
        response._content = json.dumps(
            {"results": {event["uuid"]: {"result": "ok"} for event in body.get("batch", [])}}
        ).encode()
        return response

    @property
    def events(self) -> list[dict[str, Any]]:
        with self._lock:
            return [event for sent in self.requests for event in sent["body"].get("batch", [])]

    @property
    def raw(self) -> str:
        with self._lock:
            return "\n".join(sent["raw"] + json.dumps(sent["headers"]) for sent in self.requests)


@contextlib.contextmanager
def caught() -> Iterator[Wire]:
    """PostHog's HTTP requests caught, and no connection allowed."""
    wire = Wire()
    original = HTTPAdapter.send
    HTTPAdapter.send = lambda adapter, request, **options: wire.send(request)  # type: ignore[method-assign]
    try:
        with no_network():
            yield wire
    finally:
        HTTPAdapter.send = original  # type: ignore[method-assign]


def keys_everywhere(event: dict[str, Any]) -> set[str]:
    """The event's own keys and its properties' keys."""
    return set(event) | set(event.get("properties", {}))
