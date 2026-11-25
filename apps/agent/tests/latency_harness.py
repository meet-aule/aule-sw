"""How long the tutor takes to answer a push-to-talk turn, from the release of
the talk button to the first frame of its answer, measured offline.

The real worker entrypoint runs: LiveKit's AgentSession, the Tutor, both
safety gates, the platform client, the push-to-talk RPC handlers and the
model's plugin. Every provider is a stand-in from ``fakes`` with delays drawn
from the table in its ``Delays``, and no connection leaves the machine. The
child is scripted: they press, speak, hold the button a little or a while,
release, and the page waits its 200 ms tail before it says so.

    uv run python tests/latency_harness.py --turns 120 --mix free --seed 7

prints JSON: release to first frame (p50, p90) by kind of turn, release to the
model's own first sentence for tool turns, the agent's own timing summary,
model calls and the prompt cache, and counters that must stay at zero.

``--mode open-mic`` drives sessions without the talk button: the child speaks
and the voice detector ends the turn, and the time runs from the end of their
speech. ``--playout-speed 1`` plays the tutor's audio in real time and
``--gap 2,8`` leaves the child that long to think between turns, so that the
connections the providers keep open time out as they would; by default audio
plays ten times faster and the next press follows within a second.
``--second-reader 0.05,0.02`` is the share of the child's turns and of the
tutor's replies that moderation is unsure of, so that the second reader reads
them (the default).
"""

from __future__ import annotations

import argparse
import asyncio
import contextlib
import json
import logging
import math
import os
import random
import statistics
import sys
import time
from collections.abc import Awaitable, Callable, Iterator
from dataclasses import asdict, dataclass, field
from types import SimpleNamespace
from typing import Any

import anthropic
import fakes
from fakes import (
    CHILD_WORDS,
    CURRENT_WORLD,
    TRIGGERS,
    Delays,
    Microphone,
    Speakers,
    Transcript,
    TurnPlan,
    World,
    no_network,
    reply_for,
    words_of,
)
from livekit.agents import AgentSession
from livekit.agents.cli.log import JsonFormatter

from aule_agent import worker
from aule_agent.config import Settings
from aule_agent.moderation import Moderator
from aule_agent.opinion import SecondOpinion
from aule_agent.physical_safety import PhysicalSafetyGuard
from aule_agent.platform import Platform
from aule_agent.replies import MEANWHILE, REPLIES
from aule_agent.safety import Gates

# The page waits this long after the release before it turns the microphone
# off and sends end_turn (TALK_TAIL_MS in the playground).
PAGE_TAIL_SECONDS = 0.2
# How long the child takes to start talking after pressing.
TALK_AFTER_PRESS_SECONDS = 0.2

ENV = {
    "LIVEKIT_URL": "ws://127.0.0.1:7880",
    "LIVEKIT_API_KEY": "key",
    "LIVEKIT_API_SECRET": "secret",
    "ANTHROPIC_API_KEY": "sk-ant-synthetic",
    "AULE_STT": "deepgram",
    "DEEPGRAM_API_KEY": "dg-synthetic",
    "AULE_TTS": "assemblyai",
    "ASSEMBLYAI_API_KEY": "aai-synthetic",
    "AULE_TTS_VOICE": "aai-antonioluis",
    "OPENAI_API_KEY": "sk-synthetic",
    "TYPESAFE_API_KEY": "ts-synthetic",
    "AULE_PUSH_TO_TALK": "1",
    "AULE_SESSION_MAX_MINUTES": "60",
}
METADATA = json.dumps({"audience": "child", "language": "es", "platform_token": "agent-token"})
# How the child takes turns: with the talk button, or with the microphone open,
# when the voice detector ends the turn. LiveKit's own end-of-turn model, which
# an open microphone uses by default, needs LiveKit's inference service or its
# local model: the voice detector stands in for it, with the same wait after
# the speech (``worker.TURNS``) and the same early start, which LiveKit gives
# both.
MODES = ("push-to-talk", "open-mic")
# What moderation is unsure of (fakes), so that the second reader reads it.
UNSURE = TRIGGERS["unsure_score"]
MEANWHILE_LINES = {REPLIES[key]["es"] for key in MEANWHILE}
FIXED_LINES = {text for languages in REPLIES.values() for text in languages.values()}


# --- The room, the job and a session with no room ---------------------------


class Local:
    """The agent's own participant: the RPCs the page calls, and what it is sent."""

    def __init__(self, world: World) -> None:
        self._world = world
        self.attributes: dict[str, str] = {}

    def register_rpc_method(self, name: str, handler: Any) -> None:
        self._world.rpcs[name] = handler

    async def set_attributes(self, attributes: dict[str, str]) -> None:
        self.attributes.update(attributes)

    async def send_text(self, text: str, *, topic: str = "") -> None:
        self._world.mark(f"sent {topic}")


class Room:
    def __init__(self, world: World) -> None:
        self.name = "session-synthetic"
        self.remote_participants: dict[str, Any] = {}
        self.local_participant = Local(world)

    def on(self, event: str, handler: Any = None) -> Any:
        return handler

    def off(self, event: str, handler: Any = None) -> None:
        return None

    def isconnected(self) -> bool:
        return True


class Job:
    """Just enough of LiveKit's JobContext for the entrypoint."""

    def __init__(self, world: World) -> None:
        self.room = Room(world)
        self.job = SimpleNamespace(metadata=METADATA, room=SimpleNamespace(name=self.room.name))
        self.proc = SimpleNamespace(userdata={"vad": world.vad})
        self.cleanups: list[Callable[[], Awaitable[None]]] = []

    async def connect(self) -> None:
        return None

    async def wait_for_participant(self) -> Any:
        return SimpleNamespace(identity="child-synthetic")

    def add_shutdown_callback(self, callback: Callable[[], Awaitable[None]]) -> None:
        self.cleanups.append(callback)

    def shutdown(self, reason: str = "") -> None:
        CURRENT_WORLD.get().mark(f"shutdown {reason}")

    async def delete_room(self, name: str) -> None:
        return None


class OfflineSession(AgentSession):
    """LiveKit's own session, started on the stand-in microphone, speakers and
    transcript instead of a room."""

    def __init__(self, **options: Any) -> None:
        super().__init__(**options)
        CURRENT_WORLD.get().session = self

    async def start(self, agent: Any, **options: Any) -> Any:  # type: ignore[override]
        world = CURRENT_WORLD.get()
        world.tutor = agent
        self.input.audio = Microphone()
        self.output.audio = Speakers(world)
        self.output.transcription = Transcript(world)
        return await super().start(agent, record=False)


def gates_for(world: World, report: Any = None) -> Gates:
    gates = Gates(
        moderation=Moderator("sk-synthetic", client=world.moderation_client),
        physical_safety=PhysicalSafetyGuard(
            "ts-synthetic", send=world.typesafe.send, list_models=world.typesafe.list_models
        ),
        report=report,
        second_opinion=SecondOpinion(client=world.reader_client),
    )
    spy(world, gates)
    return gates


def spy(world: World, gates: Gates) -> None:
    """Records when each turn was decided and what the output gate approved."""
    heard, spoken = gates.heard, gates.spoken

    async def heard_spy(context: Any, message: Any) -> Any:
        decision = await heard(context, message)
        world.decided.append((time.time(), decision.allowed))
        return decision

    async def spoken_spy(text: str) -> Any:
        decision = await spoken(text)
        if decision.allowed:
            world.approved.append(text)
        return decision

    gates.heard = heard_spy  # type: ignore[method-assign]
    gates.spoken = spoken_spy  # type: ignore[method-assign]


@contextlib.contextmanager
def offline(extra_env: dict[str, str] | None = None, mode: str = "push-to-talk") -> Iterator[None]:
    """The worker's providers, session and platform stood in for, for every
    session of the current world (``CURRENT_WORLD``), and no network."""
    env = {**ENV, **(extra_env or {})}
    if mode == "open-mic":
        env["AULE_PUSH_TO_TALK"] = ""
    settings = Settings.from_env(env)
    saved_env = {name: os.environ.get(name) for name in ("ANTHROPIC_API_KEY", "AULE_PLATFORM_URL")}
    os.environ["ANTHROPIC_API_KEY"] = env["ANTHROPIC_API_KEY"]
    os.environ["AULE_PLATFORM_URL"] = "http://platform.invalid"
    patches: list[tuple[Any, str, Any]] = [
        (worker, "Settings", SimpleNamespace(from_env=lambda: settings)),
        (
            worker,
            "build_gates",
            lambda settings, report=None: gates_for(CURRENT_WORLD.get(), report),
        ),
        (
            worker,
            "Platform",
            lambda linked: Platform(linked, send=CURRENT_WORLD.get().platform.send),
        ),
        (worker, "AgentSession", OfflineSession),
        (worker, "build_stt", lambda settings, language: CURRENT_WORLD.get().stt),
        (worker, "build_tts", lambda settings, language: CURRENT_WORLD.get().voice),
        (anthropic, "AsyncClient", fakes.anthropic_client),
        (anthropic, "AsyncAnthropic", fakes.anthropic_client),
    ]
    if mode == "open-mic":
        patches.append((worker, "TURNS", {**worker.TURNS, "turn_detection": "vad"}))
    saved = [(target, name, getattr(target, name)) for target, name, _ in patches]
    for target, name, value in patches:
        setattr(target, name, value)
    try:
        with no_network():
            yield
    finally:
        for target, name, value in saved:
            setattr(target, name, value)
        for name, value in saved_env.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


# --- The child's turns --------------------------------------------------------


@dataclass
class Turn:
    number: int
    kind: str  # reply, tool, scripted, off_script
    words: str
    speech: float
    hold: float
    tool: str | None = None
    # A word said as the button goes up, this long after the release, for
    # this long, whether it is loud enough for the voice detector, and how
    # long after it the hearing finalizes it (drawn when not given).
    tail_word: str | None = None
    tail_after: float = 0.0
    tail_seconds: float = 0.4
    tail_vad: bool = True
    tail_final: float | None = None
    # Whether the hearing finalizes what was said (a slow one sends only interims).
    final: bool = True


@dataclass
class TurnResult:
    number: int
    kind: str
    tool: str | None
    hold: float
    # The release, or with the microphone open the end of the child's speech.
    released_at: float
    rpc_at: float
    words: str = ""
    decided_at: float | None = None
    allowed: bool | None = None
    first_audio: float | None = None
    first_model_audio: float | None = None
    first_texts: list[str] = field(default_factory=list)
    # Everything from the press to the end of the answer: what was played,
    # what the page showed and what the model was asked.
    played: list[fakes.Played] = field(default_factory=list)
    shown: list[str] = field(default_factory=list)
    calls: list[fakes.ModelCall] = field(default_factory=list)
    # The machine slept during the turn: its times are not measurements.
    slept: bool = False

    def heard(self) -> str:
        return " ".join(text for segment in self.played for text in segment.texts)


def plan_turns(
    world: World,
    count: int,
    start: int,
    *,
    holds: str = "mixed",
    unsure: tuple[float, float] = (0.0, 0.0),
) -> list[Turn]:
    """Turns of a free session (65 % answered in one step, 35 % with a tool
    first) or of an engine session (80 % said from the script). ``unsure`` is
    the share of the child's turns and of the model's replies that moderation
    is unsure of, and that the second reader then reads."""
    rng = world.rng
    # Drawn apart, so that the turns are the same whatever the shares.
    readers = random.Random(f"second reader {world.seed}")
    turns = []
    for offset in range(count):
        number = start + offset
        words = words_of(number, UNSURE if readers.random() < unsure[0] else "")
        unsure_reply = f" {UNSURE}" if readers.random() < unsure[1] else ""
        speech = rng.uniform(0.8, 2.5)
        quick = holds == "quick" or (holds == "mixed" and rng.random() < 0.5)
        hold = rng.uniform(0.0, 0.35) if quick else fakes.Spread(0.8, 2.0).draw(rng)
        if world.mix == "engine" and rng.random() < 0.8:
            echoes = rng.random() < 0.3
            line = fakes.ENGINE_LINES[number % len(fakes.ENGINE_LINES)].format(n=number)
            world.platform.scripted_turns[words] = {"lines": [{"say": line, "echoes": echoes}]}
            turns.append(Turn(number, "scripted", words, speech, hold))
            continue
        if world.mix == "engine":
            world.platform.scripted_turns[words] = {
                "converse": f"Regla del momento {number}: sin pistas ahora."
            }
        tool = None
        if rng.random() < 0.35:
            tools = (
                ("show",) if world.mix == "engine" else ("check_answer", "pose_exercise", "show")
            )
            weights = (1,) if world.mix == "engine" else (0.45, 0.25, 0.30)
            tool = rng.choices(tools, weights)[0]
        tokens = {
            "check_answer": fakes.Spread(25, 40),
            "pose_exercise": fakes.Spread(35, 50),
            "show": fakes.Spread(150, 300),
        }
        if tool is None:
            world.plans[words] = TurnPlan(reply=reply_for(rng, number) + unsure_reply)
            kind = "reply"
        else:
            world.plans[words] = TurnPlan(
                reply="",
                tool=tool,
                tool_tokens=max(8, round(tokens[tool].draw(rng))),
                reply_after_tool=reply_for(rng, number) + unsure_reply,
                preamble="Primero lo registro." if rng.random() < 0.3 else "",
            )
            kind = "tool"
        turns.append(
            Turn(number, kind if world.mix == "free" else "off_script", words, speech, hold, tool)
        )
    return turns


async def _until(condition: Callable[[], bool], timeout: float) -> bool:
    deadline = time.monotonic() + timeout
    while not condition():
        if time.monotonic() > deadline:
            return False
        await asyncio.sleep(0.01)
    return True


async def _sleep_until(at: float) -> None:
    await asyncio.sleep(max(0.0, at - time.time()))


RPC = SimpleNamespace(
    payload="", caller_identity="child-synthetic", request_id="r", response_timeout=10
)


async def quiet(world: World, timeout: float = 30.0) -> None:
    """Until the tutor has said everything it had to say."""
    session = world.session
    deadline = time.monotonic() + timeout
    calm_since: float | None = None
    while time.monotonic() < deadline:
        calm = session.agent_state == "listening" and session.current_speech is None
        if calm:
            calm_since = calm_since or time.monotonic()
            if time.monotonic() - calm_since > 0.3:
                return
        else:
            calm_since = None
        await asyncio.sleep(0.02)


async def drive(world: World, turn: Turn) -> TurnResult:
    """One turn: press, speak, hold, release, and the page's tail."""
    delays, rng, speaker = world.delays, world.rng, world.speaker
    clocks = time.time() - time.monotonic()
    await asyncio.sleep(fakes.Spread(0.05, 0.10).draw(rng))
    played, shown, calls = len(world.played), len(world.shown), len(world.model_calls)
    streams = len(world.stt.streams)
    speaker.unmute()
    await world.rpcs["start_turn"](RPC)
    await _until(lambda: len(world.stt.streams) > streams, timeout=2.0)
    start = time.time() + TALK_AFTER_PRESS_SECONDS
    end = start + turn.speech
    final = delays.final_after_speech.draw(rng) if turn.final else None
    speaker.say(turn.words, start, end, final_delay=final)
    released = end + turn.hold
    decided = len(world.decided)
    await _sleep_until(released)
    if turn.tail_word is not None:
        at = released + turn.tail_after
        speaker.say(
            turn.tail_word,
            at,
            at + turn.tail_seconds,
            final_delay=(
                turn.tail_final
                if turn.tail_final is not None
                else delays.final_after_speech.draw(rng)
            ),
            vad=turn.tail_vad,
        )
    await asyncio.sleep(PAGE_TAIL_SECONDS)
    speaker.mute()
    await asyncio.sleep(fakes.Spread(0.05, 0.10).draw(rng))
    result = TurnResult(
        turn.number,
        turn.kind,
        turn.tool,
        turn.hold,
        released_at=released,
        rpc_at=time.time(),
        words=turn.words,
    )
    await world.rpcs["end_turn"](RPC)
    return await _answered(world, result, (played, shown, calls, decided), clocks)


async def talk(world: World, turn: Turn) -> TurnResult:
    """One turn with the microphone open: the child speaks, and the voice
    detector and LiveKit end the turn."""
    delays, rng, speaker = world.delays, world.rng, world.speaker
    clocks = time.time() - time.monotonic()
    await asyncio.sleep(fakes.Spread(0.05, 0.10).draw(rng))
    played, shown, calls = len(world.played), len(world.shown), len(world.model_calls)
    start = time.time() + TALK_AFTER_PRESS_SECONDS
    end = start + turn.speech
    final = delays.final_after_speech.draw(rng) if turn.final else None
    decided = len(world.decided)
    speaker.say(turn.words, start, end, final_delay=final)
    await _sleep_until(end)
    result = TurnResult(
        turn.number, turn.kind, turn.tool, 0.0, released_at=end, rpc_at=end, words=turn.words
    )
    return await _answered(world, result, (played, shown, calls, decided), clocks)


async def _answered(
    world: World, result: TurnResult, before: tuple[int, int, int, int], clocks: float
) -> TurnResult:
    """The turn's answer, once the tutor has said all of it."""
    played, shown, calls, decided = before
    released = result.released_at
    await _until(lambda: len(world.played) > played, timeout=20.0)
    await quiet(world)
    # Asleep, the wall clock runs on and the monotonic one does not.
    result.slept = abs(time.time() - time.monotonic() - clocks) > 0.5
    if len(world.decided) > decided:
        result.decided_at, result.allowed = world.decided[decided]
    result.played = world.played[played:]
    result.shown = [text for _, text in world.shown[shown:]]
    result.calls = world.model_calls[calls:]
    answers = [segment for segment in result.played if segment.started_at > released]
    if answers:
        result.first_audio = answers[0].started_at - released
        result.first_texts = answers[0].texts
        model = [
            segment
            for segment in answers
            if segment.texts and not set(segment.texts) <= MEANWHILE_LINES
        ]
        if model:
            result.first_model_audio = model[0].started_at - released
    return result


# --- Sessions -------------------------------------------------------------------


@dataclass
class SessionRun:
    world: World
    results: list[TurnResult]
    timing: dict[str, float]


async def run_session(
    world: World,
    turns: list[Turn],
    *,
    mode: str = "push-to-talk",
    gap: tuple[float, float] = (0.3, 0.8),
) -> SessionRun:
    """One whole session through the worker's entrypoint, then its end. The
    child waits ``gap`` seconds (at random within it) after each answer."""
    token = CURRENT_WORLD.set(world)
    job = Job(world)
    results: list[TurnResult] = []
    take = talk if mode == "open-mic" else drive
    try:
        await worker.entrypoint(job)
        await _until(
            lambda: bool(world.played) and (mode == "open-mic" or "end_turn" in world.rpcs),
            timeout=10.0,
        )
        await quiet(world)
        for turn in turns:
            results.append(await take(world, turn))
            await asyncio.sleep(world.rng.uniform(*gap))
    finally:
        for cleanup in job.cleanups:
            await cleanup()
        if world.session is not None:
            await world.session.aclose()
        world.speaker.close()
        CURRENT_WORLD.reset(token)
    return SessionRun(world, results, dict(world.metrics))


# --- What a run says ------------------------------------------------------------


def percentile(values: list[float], p: float) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[min(len(ordered) - 1, max(0, math.ceil(p * len(ordered)) - 1))]


def spread(values: list[float]) -> dict[str, Any]:
    return {
        "n": len(values),
        "p50_ms": None if not values else round(statistics.median(values) * 1000),
        "p90_ms": None if not values else round(percentile(values, 0.9) * 1000),  # type: ignore[operator]
    }


class Records(logging.Handler):
    """Every record of the run, formatted as the worker formats them."""

    def __init__(self) -> None:
        super().__init__(level=logging.DEBUG)
        self.setFormatter(JsonFormatter())
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(self.format(record))


def unapproved(world: World) -> int:
    """Sentences heard that no gate approved and that are no fixed line."""
    count = 0
    for segment in world.played:
        for text in segment.texts:
            fixed = any(text.strip() in line or line in text for line in FIXED_LINES)
            engine = any(text.strip(" .") in line for line in _engine_lines(world))
            greeting = segment is world.played[0]
            if not (fixed or engine or greeting or any(text.strip() in a for a in world.approved)):
                count += 1
    return count


def _engine_lines(world: World) -> list[str]:
    lines = ["¡Hola! Empezamos."]
    for reply in world.platform.scripted_turns.values():
        lines += [line["say"] for line in reply.get("lines", [])]
    return lines


def summarize(
    runs: list[SessionRun], records: Records, lag: list[float], drift: list[float]
) -> dict[str, Any]:
    every = [result for run in runs for result in run.results]
    results = [result for result in every if not result.slept]
    answered = [r for r in results if r.first_audio is not None]
    by_kind: dict[str, list[float]] = {}
    for result in answered:
        by_kind.setdefault(result.kind, []).append(result.first_audio)  # type: ignore[arg-type]
    tool_model = [
        r.first_model_audio for r in answered if r.kind in ("tool", "off_script") and r.tool
    ]
    calls = [call for run in runs for call in run.world.model_calls]
    streamed = [call for call in calls if call.kwargs.get("stream") is True]
    read = sum(call.cache_read for call in calls)
    total = sum(call.cache_read + call.cache_write + call.uncached for call in calls)
    timings: dict[str, list[float]] = {}
    for run in runs:
        for key, value in run.timing.items():
            timings.setdefault(key, []).append(value)
    before_gates = sum(
        1
        for r in answered
        if r.decided_at is not None and r.released_at + r.first_audio < r.decided_at  # type: ignore[operator]
    )
    # Requests that carried a turn's words to the model before its input gates
    # decided: none unless the reply is asked early (AULE_EARLY_REPLY), or
    # LiveKit's own early start runs (main, with the microphone open).
    asked_early = sum(
        1
        for r in results
        for call in r.calls
        if r.decided_at is not None
        and call.opened_at < r.decided_at
        and r.words in json.dumps(call.kwargs.get("messages"), ensure_ascii=False)
    )
    return {
        "turns": len(results),
        "turns_left_out_because_the_machine_slept": len(every) - len(results),
        "answered": len(answered),
        "release_to_first_audio": spread([r.first_audio for r in answered]),  # type: ignore[misc]
        "by_kind": {kind: spread(values) for kind, values in sorted(by_kind.items())},
        "tool_turns_release_to_first_model_sentence": spread(
            [value for value in tool_model if value is not None]
        ),
        "quick_release": spread([r.first_audio for r in answered if r.hold <= 0.35]),  # type: ignore[misc]
        "held_button": spread([r.first_audio for r in answered if r.hold > 0.35]),  # type: ignore[misc]
        "agent_timing_median_of_sessions": {
            key: round(statistics.median(values), 1) for key, values in sorted(timings.items())
        },
        "model": {
            "calls": len(calls),
            "streamed": len(streamed),
            "not_streamed": len(calls) - len(streamed),
            "closed_before_the_end": sum(1 for call in streamed if call.finished_at is None),
            "per_turn": round(len(calls) / max(1, len(results)), 2),
            "input_tokens_per_call": round(total / max(1, len(calls))),
            "cache_read_share": round(read / total, 3) if total else None,
        },
        "model_requests_before_the_input_gates": asked_early,
        "second_reader_calls": sum(len(run.world.reader_calls) for run in runs),
        "zero_counters": {
            "api_errors": sum(len(run.world.api_errors) for run in runs),
            "audio_before_the_input_gates": before_gates,
            "heard_without_the_output_gate": sum(unapproved(run.world) for run in runs),
            "log_lines_with_the_childs_words": sum(CHILD_WORDS in line for line in records.lines),
            "unanswered_turns": len(results) - len(answered),
        },
        # Whole seconds the wall clock ran ahead of the monotonic one.
        "seconds_the_machine_slept": int(max(drift, default=0.0)),
        "event_loop_lag_ms_p99": round((percentile(lag, 0.99) or 0) * 1000, 1),
    }


async def _watch_the_loop(lag: list[float], drift: list[float], stop: asyncio.Event) -> None:
    """How late the event loop runs, and how far the wall clock moved from the
    monotonic one: a machine that sleeps during a run moves the first only, and
    the turns it interrupted are not measurements."""
    wall, mono = time.time(), time.monotonic()
    while not stop.is_set():
        before = time.monotonic()
        await asyncio.sleep(0.01)
        lag.append(max(0.0, time.monotonic() - before - 0.01))
        drift.append(abs((time.time() - wall) - (time.monotonic() - mono)))


async def measure(
    *,
    turns: int,
    mix: str,
    seed: int,
    sessions: int,
    delays: Delays | None = None,
    env: dict[str, str] | None = None,
    holds: str = "mixed",
    mode: str = "push-to-talk",
    gap: tuple[float, float] = (0.3, 0.8),
    unsure: tuple[float, float] = (0.05, 0.02),
) -> dict[str, Any]:
    """Runs ``turns`` turns over ``sessions`` concurrent sessions and says how
    they went."""
    delays = delays or Delays()
    per_session = max(1, math.ceil(turns / sessions))
    records = Records()
    root = logging.getLogger()
    root.addHandler(records)
    level = root.level
    root.setLevel(logging.INFO)
    lag: list[float] = []
    drift: list[float] = []
    stop = asyncio.Event()
    watcher = asyncio.create_task(_watch_the_loop(lag, drift, stop))
    try:
        with offline(env, mode):
            worlds = [
                World(seed=seed * 1000 + index, delays=delays, mix=mix) for index in range(sessions)
            ]
            plans = [
                plan_turns(world, per_session, 1, holds=holds, unsure=unsure) for world in worlds
            ]
            runs = await asyncio.gather(
                *(
                    run_session(world, plan, mode=mode, gap=gap)
                    for world, plan in zip(worlds, plans, strict=True)
                )
            )
    finally:
        stop.set()
        await watcher
        root.removeHandler(records)
        root.setLevel(level)
    summary = summarize(list(runs), records, lag, drift)
    summary["settings"] = {
        "mix": mix,
        "seed": seed,
        "sessions": sessions,
        "turns_per_session": per_session,
        "holds": holds,
        "mode": mode,
        "gap_seconds": list(gap),
        "second_reader_shares": list(unsure),
        "env": {key: value for key, value in (env or {}).items()},
        "delays": {key: str(value) for key, value in asdict(delays).items()},
    }
    return summary


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--turns", type=int, default=120)
    parser.add_argument("--mix", choices=("free", "engine"), default="free")
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--sessions", type=int, default=12)
    parser.add_argument("--holds", choices=("mixed", "quick", "held"), default="mixed")
    parser.add_argument("--mode", choices=MODES, default="push-to-talk")
    parser.add_argument("--playout-speed", type=float, default=Delays.playout_speed)
    parser.add_argument("--gap", default="0.3,0.8", help="seconds between turns: MIN,MAX")
    parser.add_argument(
        "--second-reader", default="0.05,0.02", help="shares read again: INPUT,OUTPUT"
    )
    parser.add_argument("--env", action="append", default=[], help="NAME=value for Settings")
    arguments = parser.parse_args()
    env = dict(item.split("=", 1) for item in arguments.env)
    low, high = (float(value) for value in arguments.gap.split(","))
    heard, spoken = (float(value) for value in arguments.second_reader.split(","))
    warnings = logging.StreamHandler(sys.stderr)
    warnings.setLevel(logging.WARNING)
    logging.getLogger().addHandler(warnings)
    summary = asyncio.run(
        measure(
            turns=arguments.turns,
            mix=arguments.mix,
            seed=arguments.seed,
            sessions=arguments.sessions,
            delays=Delays(playout_speed=arguments.playout_speed),
            env=env,
            holds=arguments.holds,
            mode=arguments.mode,
            gap=(low, high),
            unsure=(heard, spoken),
        )
    )
    json.dump(summary, sys.stdout, indent=2, ensure_ascii=False)
    sys.stdout.write("\n")


if __name__ == "__main__":
    main()
