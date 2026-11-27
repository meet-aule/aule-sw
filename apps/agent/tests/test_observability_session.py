"""What whole sessions send PostHog: the real worker entrypoint, LiveKit's
session, the tutor and both gates (``latency_harness``), every provider stood
in for, and the production PostHog client with its requests caught at the
HTTP layer (``posthog_wire``). With early replies off and on."""

import asyncio
from dataclasses import dataclass
from datetime import datetime
from typing import Any

import latency_harness as harness
import pytest
from fakes import CHILD_WORDS, TRIGGERS, World, words_of
from posthog_wire import ENDPOINT, POSTHOG_ENV, SDK_KEYS, caught
from test_latency_invariants import FAST, ORDINARY, SESSIONS, Spec, scripted

from aule_agent import worker
from aule_agent.observability import ALLOWED, GENERATION, TRACE, Observability
from aule_agent.timing import STAGES

SCRIPTS: dict[str, list[Spec]] = {
    # A turn answered in one step, then turns whose reply follows tools.
    "meanwhile": SESSIONS["meanwhile"],
    # A reply the output gate's second reader reads, and lets through.
    "reply_reader_yes": SESSIONS["reply_reader_yes"],
    # A reply the output gate stops, which ends a sentence as replies do.
    "reply_stopped_sentence": [
        ORDINARY,
        Spec(reply=f"Te voy a decir algo {TRIGGERS['violence']}."),
    ],
    # Turns the input gates stop: moderation, its second reader, and the
    # physical-safety gate, for a hazard and for one it is unsure of.
    "self_harm_support": SESSIONS["self_harm_support"],
    "second_reader_concern": SESSIONS["second_reader_concern"],
    "adult_help": [ORDINARY, Spec(extra=TRIGGERS["hazard"]), Spec(extra=TRIGGERS["hazard"])],
    "clarify": SESSIONS["clarify"],
    # A turn the input gates stop, for which the model, asked early, begins a
    # drawing.
    "stopped_tool": SESSIONS["stopped_tool"],
    # Faint words the two second readers find ordinary: the first clear
    # answer settles it and stops the other.
    "faint_ordinary": [ORDINARY, Spec(extra=TRIGGERS["faint"])],
}
# The turns of those scripts the input gates stop.
STOPPED_TURNS = 6
MODES = {"early_off": {}, "early_on": {"AULE_EARLY_REPLY": "1"}}


@dataclass
class Sent:
    run: harness.SessionRun
    requests: list[dict[str, Any]]
    events: list[dict[str, Any]]
    raw: str


async def sessions(env: dict[str, str]) -> dict[str, Sent]:
    """Every script at once, as the invariants run them. Each session's
    events are told apart by the uuid its own client gave each of them."""
    made: dict[str, set[str]] = {}
    observers: list[Observability] = []
    configured = Observability.configured

    def recorded(settings: Any) -> Observability | None:
        observer = configured(settings)
        if observer is not None:
            uuids = made.setdefault(harness.CURRENT_WORLD.get().name, set())
            capture = observer._client.capture
            observer._client.capture = lambda *a, **o: uuids.add(capture(*a, **o))  # type: ignore[method-assign]
            observers.append(observer)
        return observer

    saved = worker.Observability.configured, worker.LAST_EVENTS_SECONDS
    # The harness closes a session after the job's shutdown callbacks, not
    # beside them as LiveKit does: the wait for it is not waited out.
    worker.Observability.configured = recorded  # type: ignore[method-assign]
    worker.LAST_EVENTS_SECONDS = 0.05
    try:
        with caught() as wire, harness.offline({**env, **POSTHOG_ENV}):
            worlds = {}
            for name in SCRIPTS:
                worlds[name] = World(seed=sum(map(ord, name)), delays=FAST)
                worlds[name].name = name
            runs = await asyncio.gather(
                *(
                    harness.run_session(world, scripted(world, SCRIPTS[name]))
                    for name, world in worlds.items()
                )
            )
            for observer in observers:
                # What a session's close reported, after the harness closed it.
                await observer.close()
                observer._client.shutdown()
    finally:
        worker.Observability.configured, worker.LAST_EVENTS_SECONDS = saved
    assert sorted(made) == sorted(SCRIPTS) and len(observers) == len(SCRIPTS)
    sent = {}
    for name, run in zip(worlds, runs, strict=True):
        requests = [
            request
            for request in wire.requests
            if {e["uuid"] for e in request["body"]["batch"]} <= made[name]
        ]
        events = [event for request in requests for event in request["body"]["batch"]]
        raw = "\n".join(request["raw"] for request in requests)
        sent[name] = Sent(run, requests, events, raw)
    # Every request carried one session's events only, and all of them arrived.
    assert sum(len(one.events) for one in sent.values()) == len(wire.events)
    return sent


@pytest.fixture(scope="module")
def sent() -> dict[tuple[str, str], Sent]:
    async def every() -> dict[tuple[str, str], Sent]:
        found = {}
        for mode, env in MODES.items():
            for name, one in (await sessions(env)).items():
                found[(mode, name)] = one
        return found

    return asyncio.run(every())


def at(event: dict[str, Any]) -> float:
    return datetime.fromisoformat(event["timestamp"]).timestamp()


def by_turn(sent: Sent) -> tuple[list[dict[str, Any]], list[list[dict[str, Any]]]]:
    """The events made before the first turn, and those of each turn: from its
    end_turn to the next one's."""
    starts = [result.rpc_at for result in sent.run.results]
    before: list[dict[str, Any]] = []
    turns: list[list[dict[str, Any]]] = [[] for _ in starts]
    for event in sent.events:
        index = sum(1 for start in starts if start <= at(event)) - 1
        (before if index < 0 else turns[index]).append(
            {"event": event["event"], **event["properties"]}
        )
    return before, turns


def secrets(name: str) -> set[str]:
    """What the child said and the tutor answered, the room and the job."""
    found = {CHILD_WORDS, "session-synthetic", "child-synthetic", "agent-token"}
    for number, spec in enumerate(SCRIPTS[name], start=1):
        found.add(words_of(number, spec.extra))
        found |= {text.strip() for text in (spec.reply, spec.preamble) if len(text.strip()) >= 6}
    return found | {trigger for trigger in TRIGGERS.values() if len(trigger) >= 6}


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("name", SCRIPTS)
def test_a_session_sends_only_the_allowlist_to_posthogs_eu_host(sent, mode, name):
    session = sent[(mode, name)]
    assert session.events
    assert {request["url"] for request in session.requests} == {ENDPOINT}
    for event in session.events:
        assert event["distinct_id"] == "aule-agent"
        assert event["options"] == {"process_person_profile": False}
        assert set(event["properties"]) <= ALLOWED[event["event"]]
        assert not set(SDK_KEYS) & (set(event) | set(event["properties"]))
    assert not [secret for secret in secrets(name) if secret in session.raw]


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("name", SCRIPTS)
def test_each_turns_model_calls_share_one_random_trace_id(sent, mode, name):
    session = sent[(mode, name)]
    before, turns = by_turn(session)
    # The warm-up, while the greeting is said: an id of its own.
    warm = [p for p in before if p.get("aule_request") == "warm_up"]
    assert len(warm) == 1 and warm[0]["aule_component"] == "tutor"
    traced = [{p["$ai_trace_id"] for p in turn} for turn in turns if turn]
    assert all(len(ids) == 1 for ids in traced), traced
    ids = [trace for one in traced for trace in one]
    assert len(set(ids)) == len(ids)
    assert not {p["$ai_trace_id"] for p in before} & set(ids)
    for turn, result in zip(turns, session.run.results, strict=True):
        tutor = [p for p in turn if p.get("aule_component") == "tutor"]
        assert all(p["aule_request"] in ("turn", "early") for p in tutor)
        if mode == "early_off":
            # Every request of the turn, reported once.
            assert len(tutor) == len(result.calls), (result.number, len(tutor))
        else:
            assert len(tutor) <= len(result.calls)
        if result.allowed and result.calls:
            assert tutor


def test_early_requests_are_told_apart_from_the_others(sent):
    requests = {
        mode: {
            p.get("aule_request")
            for name in SCRIPTS
            for p in (e["properties"] for e in sent[(mode, name)].events)
        }
        for mode in MODES
    }
    assert requests["early_off"] == {"warm_up", "turn", None}
    assert "early" in requests["early_on"]


@pytest.mark.parametrize("mode", MODES)
def test_a_reading_of_the_tutors_reply_is_traced_with_its_turn(sent, mode):
    _, turns = by_turn(sent[(mode, "reply_reader_yes")])
    last = turns[-1]
    (reading,) = [p for p in last if p.get("aule_component") == "safety_review"]
    assert reading["$ai_is_error"] is False and "aule_request" not in reading
    assert {p["$ai_trace_id"] for p in last} == {reading["$ai_trace_id"]}


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("name", SCRIPTS)
def test_the_second_reader_is_reported_for_the_tutors_replies_only(sent, mode, name):
    session = sent[(mode, name)]
    read = [text for _, text in session.run.world.reader_calls]
    heard = [text for text in read if "\nChild: " in text]
    readings = [
        e for e in session.events if e["properties"].get("aule_component") == "safety_review"
    ]
    # One event per reading of a reply; none for a reading of the child's words.
    assert len(readings) == len(read) - len(heard)
    if name in ("faint_ordinary", "second_reader_concern"):
        assert heard


@pytest.mark.parametrize("mode", MODES)
def test_a_turn_the_input_gates_stop_sends_nothing_but_a_request_asked_early(sent, mode):
    stopped = 0
    for name in SCRIPTS:
        session = sent[(mode, name)]
        _, turns = by_turn(session)
        for turn, result in zip(turns, session.run.results, strict=True):
            if result.allowed is not False:
                continue
            stopped += 1
            if mode == "early_off":
                assert turn == [], (name, result.number)
            else:
                # Asked while the gates judged the turn: its request, and nothing else.
                assert all(p.get("aule_request") == "early" for p in turn), (name, result.number)
    assert stopped == STOPPED_TURNS


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("name", SCRIPTS)
def test_each_turn_the_model_answered_is_one_trace_event_with_its_turns_trace_id(sent, mode, name):
    session = sent[(mode, name)]
    before, turns = by_turn(session)
    assert not [p for p in before if p["event"] == TRACE]
    for turn, result in zip(turns, session.run.results, strict=True):
        traced = [p for p in turn if p["event"] == TRACE]
        if result.allowed is False:
            # The input gates stopped it: no model in its stages, so no trace.
            assert traced == [], (name, result.number)
            continue
        (staged,) = traced
        # Every stage the session's timing reports for a push-to-talk turn,
        # down to the tutor's first audio, and one of the model's at least.
        stages = ("commit", "gates_in", "first_audio")
        assert {f"aule_{stage}_ms" for stage in stages} <= set(staged)
        assert {"aule_llm_ttft_ms", "aule_first_sentence_ms"} & set(staged)
        assert set(staged) - {"event"} <= ALLOWED[TRACE]
        assert staged["$ai_latency"] * 1000 == pytest.approx(staged["aule_first_audio_ms"], abs=1)
        calls = [p for p in turn if p["event"] == GENERATION]
        assert {p["$ai_trace_id"] for p in calls} <= {staged["$ai_trace_id"]}
    assert len(STAGES) == len([key for key in ALLOWED[TRACE] if key.startswith("aule_")])


def shape(turn: list[dict[str, Any]]) -> list[tuple[Any, ...]]:
    """What a turn sends, without its ids and numbers."""
    return [
        (p["event"], p.get("aule_component"), p.get("aule_request"), tuple(sorted(p))) for p in turn
    ]


@pytest.mark.parametrize("mode", MODES)
def test_a_reply_the_output_gate_stops_sends_what_one_it_lets_through_does(sent, mode):
    session = sent[(mode, "reply_stopped_sentence")]
    # The child heard the fixed line instead of the last reply.
    assert [tuple(flag) for flag in session.run.world.flags] == [
        ("moderation_output", "redirect", ["violence"])
    ]
    _, (answered, stopped) = by_turn(session)
    assert shape(stopped) == shape(answered)
    assert [p["event"] for p in stopped] == [GENERATION, TRACE]
