import json
import threading
from collections.abc import Iterator
from queue import Queue
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock
from uuid import UUID

import pytest
from posthog import Posthog, new_context, tag
from test_config import COMPLETE

from aule_agent.config import ConfigError, Settings
from aule_agent.observability import Observability, metadata_only
from aule_agent.opinion import SecondOpinion


@pytest.fixture
def posthog_client(monkeypatch: pytest.MonkeyPatch) -> Iterator[Posthog]:
    events = Queue()
    monkeypatch.setattr(
        "posthog.client._send_v1_batch",
        lambda key, host, batch, **kw: [events.put(e) for e in batch],
    )
    c = Posthog("test-project-token", sync_mode=True, privacy_mode=True, before_send=metadata_only)
    c.test_events = events
    yield c
    c.shutdown()


def metrics(**overrides: object) -> SimpleNamespace:
    return SimpleNamespace(
        **{
            "prompt_tokens": 180,
            "prompt_cached_tokens": 100,
            "cache_creation_tokens": 30,
            "completion_tokens": 12,
            "duration": 1.5,
            "ttft": 0.25,
            "cancelled": False,
            "metadata": SimpleNamespace(model_name="claude-sonnet-5-5"),
            "request_id": "sensitive-provider-id",
            "text": "PRIVATE-CHILD-TEXT",
            **overrides,
        }
    )


def queued(c: Posthog) -> dict[str, Any]:
    event = c.test_events.get_nowait()
    return event


async def test_real_sdk_queues_only_metrics_despite_context_and_payload_content(
    posthog_client,
) -> None:
    c = posthog_client
    observer = Observability(c)
    with new_context():
        tag("email", "private@example.test")
        tag("$ai_input", [{"content": "PRIVATE-PROMPT"}])
        tag("$ai_output_choices", [{"content": "PRIVATE-RESPONSE"}])
        tag("$session_id", "PRIVATE-WEB-SESSION")
        tag("$set", {"name": "PRIVATE-NAME"})
        observer.llm_metrics(metrics())
    event = queued(c)
    encoded = json.dumps(event)
    assert "PRIVATE" not in encoded and "sensitive-provider-id" not in encoded
    assert "private@example.test" not in encoded
    assert event["distinct_id"] == "aule-agent"
    assert event["options"] == {"process_person_profile": False}
    p = event["properties"]
    assert p["$ai_input_tokens"] == 50
    assert p["$ai_cache_read_input_tokens"] == 100
    assert p["$ai_cache_creation_input_tokens"] == 30
    assert p["$ai_cache_reporting_exclusive"] is True
    assert p["$ai_output_tokens"] == 12 and p["$ai_latency"] == 1.5
    assert p["$ai_time_to_first_token"] == 0.25
    assert p["$geoip_disable"] is True
    assert UUID(p["$ai_session_id"]) and UUID(p["$ai_trace_id"])
    await observer.close()


async def test_sdk_error_events_have_no_exception_text_or_invented_usage(
    posthog_client: Posthog,
) -> None:
    c = posthog_client
    observer = Observability(c)
    observer.llm_error(RuntimeError("PRIVATE-TEXT AND API KEY"))
    p = queued(c)["properties"]
    assert p["$ai_is_error"] is True and p["$ai_error"] == "provider_error"
    assert "$ai_input_tokens" not in p and "$ai_output_tokens" not in p
    assert "PRIVATE" not in json.dumps(p)
    await observer.close()


async def test_invalid_latency_is_omitted_and_anonymous_ids_do_not_cross_sessions(
    posthog_client,
) -> None:
    c = posthog_client
    first, second = Observability(c), Observability(c)
    first.llm_metrics(metrics(duration=float("nan"), ttft=-1))
    first.llm_metrics(metrics())
    second.llm_metrics(metrics())
    a, b, d = [queued(c)["properties"] for _ in range(3)]
    assert "$ai_latency" not in a and "$ai_time_to_first_token" not in a
    assert a["$ai_session_id"] == b["$ai_session_id"] != d["$ai_session_id"]
    assert a["$ai_trace_id"] != b["$ai_trace_id"]
    await first.close()
    await second.close()


def test_disabled_configuration_does_not_create_a_posthog_client(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    constructor = Mock(side_effect=AssertionError("must not initialize"))
    monkeypatch.setattr("posthog.Posthog", constructor)
    assert Observability.configured(Settings.from_env(COMPLETE)) is None
    constructor.assert_not_called()


def test_configuration_requires_an_explicit_destination_and_hides_the_token() -> None:
    env = {
        **COMPLETE,
        "POSTHOG_API_KEY": "private-test-token",
        "POSTHOG_HOST": "https://eu.i.posthog.com/",
    }
    settings = Settings.from_env(env)
    assert settings.posthog_host == "https://eu.i.posthog.com"
    assert "private-test-token" not in repr(settings)
    for bad in (
        {"POSTHOG_HOST": ""},
        {"POSTHOG_API_KEY": ""},
        {"POSTHOG_HOST": "http://example.test"},
        {"POSTHOG_HOST": "https://user:secret@example.test"},
        {"POSTHOG_HOST": "https://example.test/?key=secret"},
    ):
        with pytest.raises(ConfigError, match="POSTHOG"):
            Settings.from_env({**env, **bad})


async def test_analytics_failure_does_not_break_the_reply_and_shutdown_runs_off_loop() -> None:
    loop_thread = threading.get_ident()
    seen = []
    c = Mock()
    c.capture.side_effect = RuntimeError("PRIVATE")
    c.shutdown.side_effect = lambda: seen.append(threading.get_ident())
    observer = Observability(c)
    observer.llm_metrics(metrics())
    await observer.close()
    await observer.close()
    observer.llm_metrics(metrics())
    assert len(seen) == 1 and seen[0] != loop_thread
    assert c.capture.call_count == 1


@pytest.mark.parametrize("failed", [False, True])
async def test_second_reader_reports_usage_without_its_question_or_reply(
    failed: bool, posthog_client: Posthog
) -> None:
    c = posthog_client
    observer = Observability(c)

    class Messages:
        async def create(self, **kwargs: Any) -> SimpleNamespace:
            if failed:
                raise RuntimeError("PRIVATE-REVIEW")
            return SimpleNamespace(
                content=[SimpleNamespace(type="text", text="SAFE")],
                usage=SimpleNamespace(input_tokens=21, output_tokens=1),
            )

    reader = SecondOpinion(client=SimpleNamespace(messages=Messages()), observer=observer)
    assert await reader.safe("PRIVATE-CHILD-TEXT") is (not failed)
    # safe() always returns a boolean, including failures.
    event = queued(c)
    assert "PRIVATE" not in json.dumps(event)
    p = event["properties"]
    assert p["aule_component"] == "safety_review" and p["$ai_is_error"] is failed
    if not failed:
        assert p["$ai_input_tokens"] == 21 and p["$ai_output_tokens"] == 1
    await observer.close()
