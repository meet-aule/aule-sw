"""AI observability: what PostHog would receive from the production client
(``Observability.configured``), caught at the HTTP layer, and that analytics
never changes a reply, a gate or the end of a session."""

import asyncio
import contextvars
import json
import logging
import sys
import threading
import time
from types import SimpleNamespace
from typing import Any
from unittest.mock import Mock
from uuid import UUID, uuid4

import posthog
import pytest
from posthog_wire import ENDPOINT, EVENT_KEYS, POSTHOG_ENV, SDK_KEYS, TOKEN, caught
from test_config import COMPLETE
from test_safety import Moderation, Physical, after, said

from aule_agent import observability, worker
from aule_agent.config import POSTHOG_HOST, Settings
from aule_agent.moderation import Finding
from aule_agent.observability import (
    ALLOWED,
    GENERATION,
    TURN,
    Observability,
    metadata_only,
    new_turn,
)
from aule_agent.opinion import MODEL as READER_MODEL
from aule_agent.opinion import SecondOpinion
from aule_agent.physical_safety import Verdict
from aule_agent.providers import EARLY, WARMING, Early
from aule_agent.safety import Gates

# Things PostHog must never see.
CHILD_UUID = "7c0f3c4e-1111-4a6b-9a7e-0c1d2e3f4a5b"
PLATFORM_SESSION = "7c0f3c4e-3333-4a6b-9a7e-0c1d2e3f4a5b"
CANARIES = ("PRIVATE", "Canario", CHILD_UUID, PLATFORM_SESSION, "sensitive-provider-id")


def settings(**env: str) -> Settings:
    return Settings.from_env({**COMPLETE, **POSTHOG_ENV, **env})


@pytest.fixture
def wire():
    """PostHog's requests caught, and every client made here shut down after."""
    made: list[Observability] = []
    with caught() as wire:
        wire.made = made
        yield wire
        for observer in made:
            observer._client.shutdown()


def production(wire, **env: str) -> Observability:
    observer = Observability.configured(settings(**env))
    assert observer is not None
    wire.made.append(observer)
    return observer


def metrics(**overrides: object) -> SimpleNamespace:
    """LiveKit's LLMMetrics for one request, with content it must not send."""
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


class Reader:
    """The second reader's Anthropic client: answers in order, or never."""

    def __init__(self, *answers: object) -> None:
        self.answers = list(answers)
        self.messages = SimpleNamespace(create=self.create)

    async def create(self, **request: Any) -> SimpleNamespace:
        answer = self.answers.pop(0)
        if answer is None:
            await asyncio.Event().wait()
        if isinstance(answer, Exception):
            raise answer
        return SimpleNamespace(
            content=[SimpleNamespace(type="text", text=answer)],
            usage=SimpleNamespace(input_tokens=21, output_tokens=1, text="PRIVATE"),
        )

    async def close(self) -> None:
        return None


def by_component(events: list[dict[str, Any]], component: str) -> list[dict[str, Any]]:
    return [e["properties"] for e in events if e["properties"].get("aule_component") == component]


async def test_the_production_client_sends_only_the_allowlist_to_posthogs_eu_host(wire) -> None:
    observer = production(wire)
    # Anything else in the process that tags PostHog's context.
    with posthog.new_context(fresh=True):
        posthog.identify_context(CHILD_UUID)
        posthog.set_context_session(PLATFORM_SESSION)
        posthog.tag("$ai_session_id", PLATFORM_SESSION)
        posthog.tag("$ai_trace_id", CHILD_UUID)
        posthog.tag("$set", {"name": "PRIVATE-NAME"})
        posthog.tag("$ai_input", [{"role": "user", "content": "PRIVATE Calle Canario"}])
        posthog.tag("email", "PRIVATE@example.test")
        turn = new_turn()
        observer.llm_metrics(metrics())
        reader = SecondOpinion(client=Reader("SAFE"), observer=observer)
        assert await reader.safe("PRIVATE reply for the child")
    await observer.close()

    assert {sent["url"] for sent in wire.requests} == {ENDPOINT}
    assert {sent["method"] for sent in wire.requests} == {"POST"}
    assert {sent["headers"]["Authorization"] for sent in wire.requests} == {f"Bearer {TOKEN}"}
    events = wire.events
    assert len(events) == 2
    for event in events:
        assert set(event) == EVENT_KEYS
        assert event["event"] == GENERATION and event["distinct_id"] == "aule-agent"
        assert event["options"] == {"process_person_profile": False}
        assert set(event["properties"]) <= ALLOWED[GENERATION]
        assert not set(SDK_KEYS) & (set(event) | set(event["properties"]))
        assert event["properties"]["$ai_trace_id"] == turn
    assert not [canary for canary in CANARIES if canary in wire.raw]
    (tutor,) = by_component(events, "tutor")
    assert tutor == {
        "$ai_trace_id": turn,
        "$ai_provider": "anthropic",
        "$ai_model": "claude-sonnet-5-5",
        "$ai_cache_reporting_exclusive": True,
        "$geoip_disable": True,
        # LiveKit's prompt_tokens include the cache; PostHog's input does not.
        "$ai_input_tokens": 50,
        "$ai_cache_read_input_tokens": 100,
        "$ai_cache_creation_input_tokens": 30,
        "$ai_output_tokens": 12,
        "$ai_latency": 1.5,
        "$ai_time_to_first_token": 0.25,
        "$ai_stream": True,
        "$ai_is_error": False,
        "aule_cancelled": False,
        "aule_component": "tutor",
        "aule_request": "turn",
    }
    (review,) = by_component(events, "safety_review")
    assert set(review) == {
        "$ai_trace_id",
        "$ai_provider",
        "$ai_model",
        "$ai_cache_reporting_exclusive",
        "$geoip_disable",
        "$ai_input_tokens",
        "$ai_output_tokens",
        "$ai_latency",
        "$ai_stream",
        "$ai_is_error",
        "aule_cancelled",
        "aule_component",
    }
    assert (review["$ai_model"], review["$ai_input_tokens"]) == (READER_MODEL, 21)


async def test_a_turns_model_calls_share_a_random_trace_id_that_nothing_else_has(wire) -> None:
    observer = production(wire)

    async def step() -> None:
        observer.llm_metrics(metrics())

    async def turn() -> str:
        trace = new_turn()
        observer.llm_metrics(metrics())
        # A later step of the same turn, in a task the turn started.
        await asyncio.create_task(step())
        return trace

    first, second = await asyncio.create_task(turn()), await asyncio.create_task(turn())
    # Outside any turn (the warm-up, a greeting checked by the second reader):
    # an id of its own each time.
    contextvars.Context().run(observer.llm_metrics, metrics())
    contextvars.Context().run(observer.llm_metrics, metrics())
    await observer.close()

    traces = [event["properties"]["$ai_trace_id"] for event in wire.events]
    assert traces[:4] == [first, first, second, second]
    assert len(set(traces)) == 4 and first != second
    # Drawn at random (version 4), not derived from anything of the session.
    assert {UUID(trace).version for trace in traces} == {4}
    assert TURN.get() is None


async def test_a_request_cut_off_without_usage_has_no_token_counts_rather_than_zero(wire) -> None:
    observer = production(wire)
    new_turn()
    nothing = dict(
        prompt_tokens=0, prompt_cached_tokens=0, cache_creation_tokens=0, completion_tokens=0
    )
    observer.llm_metrics(metrics(cancelled=True, ttft=-1.0, **nothing))
    observer.llm_metrics(metrics(cancelled=True))
    await observer.close()

    unknown, counted = (event["properties"] for event in wire.events)
    assert unknown["aule_cancelled"] is True and unknown["$ai_is_error"] is False
    # Unknown cost, not $0: PostHog has nothing to price.
    assert not [key for key in unknown if key.endswith("_tokens")]
    assert "$ai_time_to_first_token" not in unknown
    assert counted["aule_cancelled"] is True and counted["$ai_input_tokens"] == 50


async def test_the_warm_up_and_a_request_made_while_the_gates_judge_are_told_apart(wire) -> None:
    observer = production(wire)

    def warm_up() -> None:
        WARMING.set(True)
        observer.llm_metrics(metrics(ttft=-1.0, completion_tokens=0))

    def early() -> None:
        EARLY.set(Early())
        observer.llm_metrics(metrics())

    contextvars.copy_context().run(warm_up)
    contextvars.copy_context().run(early)
    observer.llm_metrics(metrics())
    await observer.close()

    kinds = [(e["properties"]["aule_request"], e["properties"]["$ai_stream"]) for e in wire.events]
    assert kinds == [("warm_up", False), ("early", True), ("turn", True)]


async def test_a_failed_request_names_the_model_and_a_retried_one_is_no_failure(wire) -> None:
    observer = production(wire, AULE_LLM_MODEL="claude-sonnet-5-5")
    new_turn()
    retried = SimpleNamespace(recoverable=True, error=RuntimeError("PRIVATE retry"))
    failed = SimpleNamespace(recoverable=False, error=RuntimeError("PRIVATE Calle Canario"))
    observer.llm_error(retried)
    observer.llm_error(failed)
    await observer.close()

    (event,) = wire.events
    p = event["properties"]
    assert p["$ai_is_error"] is True and p["$ai_error"] == "provider_error"
    assert p["$ai_model"] == "claude-sonnet-5-5" and p["aule_component"] == "tutor"
    assert not [key for key in p if key.endswith("_tokens")]
    assert not [canary for canary in CANARIES if canary in wire.raw]


@pytest.mark.parametrize(
    ("finding", "answers", "allowed"),
    [
        # Nothing over our thresholds but a faint score: two readers at once,
        # and the first clear "ordinary" settles it and stops the other.
        (Finding(faint_self_harm=True), ("ORDINARY", None), True),
        # Both hear a concern: the turn is stopped with the line for a child
        # in distress.
        (Finding(faint_self_harm=True), ("CONCERN", "CONCERN"), False),
        # Neither answers.
        (Finding(faint_self_harm=True), (RuntimeError("PRIVATE"), RuntimeError("PRIVATE")), True),
        # A score over our thresholds the provider did not act on: one reader.
        (Finding(categories=("violence",), unsure=True), ("ORDINARY",), True),
        (Finding(categories=("violence",), unsure=True), ("CONCERN",), False),
    ],
)
async def test_no_reading_of_what_the_child_said_is_sent_whatever_it_finds(
    wire, finding, answers, allowed
) -> None:
    # That a reading happened, and how it went, would tell that moderation was
    # unsure of the child's words.
    observer = production(wire)
    client = Reader(*answers)
    reader = SecondOpinion(client=client, observer=observer)
    gates = Gates(
        moderation=Moderation(finding),
        physical_safety=Physical(Verdict.ALLOW),
        second_opinion=reader,
    )
    new_turn()

    decision = await gates.heard(after("¿Seguimos?"), said("ya no quiero seguir PRIVATE"))
    # A reader that was stopped would report as its cancellation ends.
    await asyncio.sleep(0.01)
    observer.review(None, about="heard", latency=0.1, failed=False, model=READER_MODEL)
    observer.review(None, about="PRIVATE", latency=0.1, failed=False, model=READER_MODEL)
    await observer.close()

    assert decision.allowed is allowed
    # Every reader was asked, and nothing reached PostHog.
    assert client.answers == []
    assert wire.requests == []


async def test_a_reading_of_a_reply_stopped_as_its_turn_ends_is_a_cancellation(wire) -> None:
    observer = production(wire)
    reader = SecondOpinion(client=Reader(None), observer=observer)
    turn = new_turn()

    reading = asyncio.create_task(reader.safe("PRIVATE reply"))
    await asyncio.sleep(0.01)
    # A new press stops the turn's reply, and the gate judging it.
    reading.cancel()
    with pytest.raises(asyncio.CancelledError):
        await reading
    await observer.close()

    (stopped,) = by_component(wire.events, "safety_review")
    # Not a provider error, and no usage known.
    assert stopped["$ai_is_error"] is False and stopped["aule_cancelled"] is True
    assert "$ai_error" not in stopped
    assert not [key for key in stopped if key.endswith("_tokens")]
    assert stopped["$ai_trace_id"] == turn


@pytest.mark.parametrize("answer", [RuntimeError("PRIVATE down"), "maybe"])
async def test_a_second_reading_that_fails_or_answers_nothing_clear(wire, answer) -> None:
    observer = production(wire)
    reader = SecondOpinion(client=Reader(answer), observer=observer)

    assert await reader.safe("PRIVATE reply") is False
    await observer.close()

    (p,) = by_component(wire.events, "safety_review")
    failed = isinstance(answer, Exception)
    assert p["$ai_is_error"] is failed and p["aule_cancelled"] is False
    assert ("$ai_input_tokens" in p) is not failed
    assert not [canary for canary in CANARIES if canary in wire.raw]


async def test_no_callback_can_raise_and_the_log_gets_the_error_type_only(caplog) -> None:
    client = Mock()
    client.capture.side_effect = RuntimeError("PRIVATE Calle Canario")
    observer = Observability(client, model="claude-sonnet-5-5")

    class Broken:
        @property
        def prompt_tokens(self) -> int:
            raise ValueError("PRIVATE metrics")

    with caplog.at_level(logging.WARNING, logger="aule.agent.observability"):
        observer.llm_metrics(metrics())
        observer.llm_metrics(Broken())
        observer.llm_error(SimpleNamespace(recoverable=False))
        observer.review(None, about="reply", latency=0.1, failed=True, model=READER_MODEL)
        # The second reader's verdict does not depend on it.
        reader = SecondOpinion(client=Reader("SAFE"), observer=observer)
        assert await reader.safe("cuenta las canicas") is True

    dropped = [r for r in caplog.records if r.getMessage() == "AI observability event dropped"]
    assert [r.error for r in dropped] == [
        "RuntimeError",
        "ValueError",
        "RuntimeError",
        "RuntimeError",
        "RuntimeError",
    ]
    assert "PRIVATE" not in caplog.text


async def test_close_flushes_off_the_loop_within_its_deadline_and_late_events_are_kept(
    monkeypatch,
) -> None:
    monkeypatch.setattr(observability, "FLUSH_SECONDS", 0.1)
    flushed: list[int] = []
    release = threading.Event()
    client = Mock()

    def flush(timeout_seconds: float) -> None:
        flushed.append(threading.get_ident())
        # PostHog does not answer: the flush outlives its deadline.
        release.wait(5)

    client.flush.side_effect = flush
    observer = Observability(client)

    started = time.monotonic()
    await observer.close()
    waited = time.monotonic() - started
    release.set()

    assert waited < 1.0
    assert flushed and flushed[0] != threading.get_ident()
    # Events that come after are taken, and the next close sends them.
    observer.llm_metrics(metrics())
    await observer.close()
    assert client.capture.call_count == 1 and len(flushed) == 2


async def test_late_events_reach_posthog_through_a_later_close(wire) -> None:
    observer = production(wire)
    observer.llm_metrics(metrics())
    await observer.close()
    # A request the session's close stopped, reported after the first flush.
    observer.llm_metrics(metrics(cancelled=True))
    await observer.close()

    assert [e["properties"]["aule_cancelled"] for e in wire.events] == [False, True]


def test_ai_observability_needs_a_project_token_and_posthogs_eu_host() -> None:
    on = settings(POSTHOG_HOST=f"{POSTHOG_HOST}/")
    assert (on.posthog_api_key, on.posthog_host, on.posthog_problem) == (TOKEN, POSTHOG_HOST, None)
    assert TOKEN not in repr(on)
    off = Settings.from_env(COMPLETE)
    assert (off.posthog_api_key, off.posthog_host, off.posthog_problem) == (None, None, None)


@pytest.mark.parametrize(
    ("env", "variable"),
    [
        ({"POSTHOG_API_KEY": "phx_PersonalKeyPRIVATE0000000000000000"}, "POSTHOG_API_KEY"),
        ({"POSTHOG_API_KEY": "phc_PRIVATE token with spaces 00000000"}, "POSTHOG_API_KEY"),
        ({"POSTHOG_API_KEY": "phc_short"}, "POSTHOG_API_KEY"),
        ({"POSTHOG_API_KEY": ""}, "POSTHOG_API_KEY"),
        ({"POSTHOG_HOST": ""}, "POSTHOG_HOST"),
        ({"POSTHOG_HOST": "https://us.i.posthog.com"}, "POSTHOG_HOST"),
        ({"POSTHOG_HOST": "http://eu.i.posthog.com"}, "POSTHOG_HOST"),
        ({"POSTHOG_HOST": "https://PRIVATE@eu.i.posthog.com"}, "POSTHOG_HOST"),
        ({"POSTHOG_HOST": "https://eu.i.posthog.com/?PRIVATE"}, "POSTHOG_HOST"),
        ({"POSTHOG_HOST": "https://posthog.example.test"}, "POSTHOG_HOST"),
    ],
)
def test_a_value_that_cannot_be_used_turns_it_off_and_names_the_variable_only(
    env, variable
) -> None:
    off = settings(**env)

    assert (off.posthog_api_key, off.posthog_host) == (None, None)
    assert off.posthog_problem.startswith(variable)
    assert "PRIVATE" not in off.posthog_problem and "phx_" not in off.posthog_problem
    assert Observability.configured(off) is None


def test_a_worker_with_a_bad_posthog_value_starts_and_says_so_in_one_line(
    monkeypatch, caplog
) -> None:
    started = []
    monkeypatch.setattr(worker.cli, "run_app", started.append)
    monkeypatch.setattr(sys, "argv", ["aule-agent", "start"])
    for name, value in {
        **COMPLETE,
        **POSTHOG_ENV,
        "POSTHOG_HOST": "https://us.i.posthog.com",
    }.items():
        monkeypatch.setenv(name, value)

    with caplog.at_level(logging.WARNING, logger="aule.agent"):
        worker.main()

    assert started == [worker.server]
    off = [r.getMessage() for r in caplog.records if "AI observability" in r.getMessage()]
    assert off == [f"AI observability is off: POSTHOG_HOST must be {POSTHOG_HOST}"]


def test_when_off_no_posthog_client_is_made(monkeypatch) -> None:
    constructor = Mock(side_effect=AssertionError("must not initialize"))
    monkeypatch.setattr("posthog.Posthog", constructor)
    assert Observability.configured(Settings.from_env(COMPLETE)) is None
    constructor.assert_not_called()


def test_the_production_client_has_the_allowlist_and_nothing_that_reaches_out(wire) -> None:
    observer = production(wire)
    client = observer._client

    assert client.host == POSTHOG_HOST
    assert client.before_send is metadata_only
    assert client.privacy_mode is True and client.exception_capture is None
    assert client.poller is None and client.disable_geoip is True
    # Making it sent nothing.
    assert wire.requests == []


def test_prewarm_works_out_the_systems_details_once_and_only_when_on(monkeypatch) -> None:
    calls = []
    monkeypatch.setattr("posthog.utils.system_context", lambda: calls.append(1) or {})

    observability.prewarm(Settings.from_env(COMPLETE))
    assert calls == []
    observability.prewarm(settings())
    assert calls == [1]

    def broken() -> dict[str, str]:
        raise OSError("PRIVATE")

    monkeypatch.setattr("posthog.utils.system_context", broken)
    observability.prewarm(settings())


def test_the_job_process_prewarms_ai_observability(monkeypatch) -> None:
    warmed = []
    monkeypatch.setattr(worker.silero.VAD, "load", lambda **options: "vad")
    monkeypatch.setattr(worker.observability, "prewarm", warmed.append)
    for name, value in {**COMPLETE, **POSTHOG_ENV}.items():
        monkeypatch.setenv(name, value)
    proc = SimpleNamespace(userdata={})

    worker.prewarm(proc)

    (prewarmed,) = warmed
    assert prewarmed.posthog_api_key == TOKEN and proc.userdata["vad"] == "vad"


def test_the_allowlist_drops_any_other_event_and_one_without_a_trace_id() -> None:
    event = {"event": GENERATION, "properties": {"$ai_trace_id": "not-a-uuid"}}
    assert metadata_only(event) is None
    assert metadata_only({"event": "$exception", "properties": {}}) is None
    assert metadata_only({"event": "$pageview", "properties": {}}) is None
    trace = str(uuid4())
    kept = metadata_only(
        {"event": GENERATION, "properties": {"$ai_trace_id": trace.upper(), "room": "PRIVATE"}}
    )
    assert kept is not None and set(kept["properties"]) <= ALLOWED[GENERATION]
    assert kept["properties"]["$ai_trace_id"] == trace and "PRIVATE" not in json.dumps(kept)
