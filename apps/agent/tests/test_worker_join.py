"""How a job begins: the platform opened the room, and the tutor waits in it
for the person it was opened for."""

import asyncio
import json
from types import SimpleNamespace
from typing import Any

import pytest
from livekit import rtc
from livekit.agents.job import DEFAULT_PARTICIPANT_KINDS
from livekit.agents.utils.participant import wait_for_participant

from aule_agent import worker
from aule_agent.observability import Observability
from aule_agent.platform import Platform
from aule_agent.worker import someone_joined

PERSON = SimpleNamespace(identity="child-1", kind=rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD)


class Room:
    """Just enough of a LiveKit room for LiveKit's own wait for a participant,
    and for what the tutor sets up in it once the session starts."""

    def __init__(self) -> None:
        self.remote_participants: dict[str, object] = {}
        self.handlers: dict[str, Any] = {}
        self.local_participant = SimpleNamespace(
            register_rpc_method=lambda name, handler: None,
            set_attributes=self._nothing,
            send_text=self._nothing,
        )

    async def _nothing(self, *args: object, **options: object) -> None:
        return None

    def isconnected(self) -> bool:
        return True

    def on(self, event: str, handler: Any) -> None:
        self.handlers[event] = handler

    def off(self, event: str, handler: Any) -> None:
        self.handlers.pop(event, None)

    def emit(self, event: str, *args: object) -> None:
        self.handlers[event](*args)


def job(room: Room) -> SimpleNamespace:
    # As JobContext.wait_for_participant calls it.
    return SimpleNamespace(
        wait_for_participant=lambda: wait_for_participant(room, kind=DEFAULT_PARTICIPANT_KINDS)
    )


async def test_the_session_starts_once_the_person_is_in_the_room():
    room = Room()
    waiting = asyncio.create_task(someone_joined(job(room)))
    await asyncio.sleep(0)
    assert not waiting.done()

    room.emit("participant_active", PERSON)

    assert await waiting


async def test_a_room_that_closes_before_anyone_comes_starts_nothing():
    room = Room()
    waiting = asyncio.create_task(someone_joined(job(room)))
    await asyncio.sleep(0)

    room.emit("connection_state_changed", rtc.ConnectionState.CONN_DISCONNECTED)

    assert not await waiting
    assert room.handlers == {}


# --- The whole entrypoint, with LiveKit's job, the platform and the paid
# services stood in for. Each stand-in writes what happened to one list, so the
# order of things is what is checked.


class Job:
    """Just enough of LiveKit's JobContext: a child's session the platform
    dispatched the tutor to, in a room nobody has joined yet."""

    def __init__(self, happened: list[Any]) -> None:
        self.happened = happened
        self.room = Room()
        self.job = SimpleNamespace(
            metadata=json.dumps(
                {"audience": "child", "language": "es", "platform_token": "agent-token"}
            )
        )
        self.proc = SimpleNamespace(userdata={"vad": object()})
        self.cleanups: list[Any] = []

    async def connect(self) -> None:
        self.happened.append("connected")

    def wait_for_participant(self) -> Any:
        return wait_for_participant(self.room, kind=DEFAULT_PARTICIPANT_KINDS)

    def add_shutdown_callback(self, callback: Any) -> None:
        self.cleanups.append(callback)

    def shutdown(self, reason: str = "") -> None:
        self.happened.append(f"shutdown: {reason}")


class Gates:
    """Both gates, as a child's session needs them; nothing is judged here."""

    checks_spoken = False

    def __init__(self, happened: list[Any]) -> None:
        self.happened = happened

    def may_start(self, audience: str) -> bool:
        return True

    async def ready(self) -> bool:
        # Both answer; asked while the tutor waits for the person.
        return True

    def for_student(self, *details: object) -> None:
        return None

    async def close(self) -> None:
        self.happened.append("gates closed")


class Session:
    """Stands in for AgentSession: the greeting and every word come from it."""

    def __init__(self, happened: list[Any]) -> None:
        self.happened = happened
        happened.append("session made")

    def on(self, event: str, handler: Any = None) -> Any:
        return handler if handler is not None else (lambda handler: handler)

    async def start(self, **options: object) -> None:
        self.happened.append("session started")

    async def say(self, *args: object, **options: object) -> None:
        self.happened.append("said")


class Service:
    """The model, the hearing and the voice: never called here."""

    def on(self, event: str, handler: Any) -> None:
        return None


@pytest.fixture
def happened(monkeypatch: pytest.MonkeyPatch) -> list[Any]:
    happened: list[Any] = []

    async def platform(method: str, path: str, body: Any, timeout: float) -> dict[str, Any]:
        happened.append((method, path, body))
        return {}

    monkeypatch.setenv("AULE_PLATFORM_URL", "http://platform")
    settings = SimpleNamespace(
        language="es",
        push_to_talk=False,
        session_max_minutes=20,
        break_minutes=30,
        early_reply=False,
        voice_ahead=False,
        posthog_api_key=None,
        posthog_host=None,
    )
    monkeypatch.setattr(worker, "Settings", SimpleNamespace(from_env=lambda: settings))
    monkeypatch.setattr(
        worker, "build_gates", lambda settings, report=None, observer=None: Gates(happened)
    )
    monkeypatch.setattr(
        worker, "Platform", lambda linked, **options: Platform(linked, send=platform, **options)
    )
    monkeypatch.setattr(worker, "AgentSession", lambda **options: Session(happened))
    for build in ("build_llm", "build_stt", "build_tts"):
        monkeypatch.setattr(worker, build, lambda *args: Service())
    return happened


async def waiting_for_someone(ctx: Job) -> None:
    """Lets the entrypoint run until it waits for the person."""
    for _ in range(100):
        if "participant_active" in ctx.room.handlers:
            return
        await asyncio.sleep(0)
    raise AssertionError("the entrypoint never waited for the person")


async def test_nothing_is_started_or_said_before_the_person_is_in_the_room(happened):
    ctx = Job(happened)
    entrypoint = asyncio.create_task(worker.entrypoint(ctx))

    await waiting_for_someone(ctx)
    await asyncio.sleep(0.05)
    # The tutor is in the room and waits: the platform is not asked to start
    # the session, and there is no session to greet anyone with.
    assert happened == ["connected"]

    happened.append("the person joined")
    ctx.room.emit("participant_active", PERSON)
    await asyncio.wait_for(entrypoint, timeout=5)

    # Without the talk button the agent says it reads a photo of the homework.
    started = ("GET", "/v1/agent/session?homework=1", None)
    assert happened[:4] == ["connected", "the person joined", started, "session made"]
    assert "session started" in happened

    for cleanup in ctx.cleanups:
        await cleanup()
    assert happened[-1] == ("POST", "/v1/agent/session/end", happened[-1][2])
    assert happened.count(started) == 1


@pytest.mark.parametrize("linked", [True, False], ids=["platform", "no platform"])
async def test_a_room_closed_before_anyone_came_ends_the_job_and_frees_the_family(
    happened, monkeypatch, linked
):
    if not linked:
        monkeypatch.delenv("AULE_PLATFORM_URL")
    ctx = Job(happened)
    entrypoint = asyncio.create_task(worker.entrypoint(ctx))
    await waiting_for_someone(ctx)

    happened.append("the room closed")
    ctx.room.emit("connection_state_changed", rtc.ConnectionState.CONN_DISCONNECTED)
    await asyncio.wait_for(entrypoint, timeout=5)

    # No start, no session, no greeting. The platform is only told the session
    # is over, so the family is not kept waiting for it to time out.
    ended = [("POST", "/v1/agent/session/end", {"end_reason": "device_offline"})]
    assert happened == [
        "connected",
        "the room closed",
        "gates closed",
        *(ended if linked else []),
        "shutdown: nobody joined the room",
    ]
    assert ctx.cleanups == []


class ClosingSession(Session):
    """A session whose own close, which LiveKit runs beside the job's other
    shutdown callbacks, reports a request it stopped before it says it closed."""

    def __init__(self, happened: list[Any]) -> None:
        super().__init__(happened)
        self.handlers: dict[str, list[Any]] = {}

    def on(self, event: str, handler: Any = None) -> Any:
        if handler is None:
            return lambda handler: self.on(event, handler)
        self.handlers.setdefault(event, []).append(handler)
        return handler

    async def close_reporting(self, stopped: Any) -> None:
        await asyncio.sleep(0.05)
        stopped()
        for handler in self.handlers.get("close", []):
            handler(SimpleNamespace(error=None))
        self.happened.append("session closed")


async def test_the_last_ai_observability_events_are_sent_after_the_sessions_own_close(
    happened: list[Any], monkeypatch: pytest.MonkeyPatch
) -> None:
    class Client:
        def capture(self, event: str, **options: Any) -> None:
            happened.append("event")

        def flush(self, timeout_seconds: float) -> None:
            happened.append("flushed")

    observer = Observability(Client())
    callbacks: dict[str, Any] = {}
    model = SimpleNamespace(
        on=lambda event, callback: callbacks.setdefault(event, []).append(callback)
    )
    sessions: list[ClosingSession] = []
    monkeypatch.setattr(worker.Observability, "configured", lambda settings: observer)
    monkeypatch.setattr(worker, "build_llm", lambda settings: model)

    def made(**options: Any) -> ClosingSession:
        sessions.append(ClosingSession(happened))
        return sessions[-1]

    monkeypatch.setattr(worker, "AgentSession", made)
    ctx = Job(happened)
    entrypoint = asyncio.create_task(worker.entrypoint(ctx))
    await waiting_for_someone(ctx)
    ctx.room.emit("participant_active", PERSON)
    await entrypoint
    assert callbacks["metrics_collected"][-1] == observer.llm_metrics
    assert callbacks["error"] == [observer.llm_error]

    # As LiveKit shuts a job down: every callback at once, the session's own
    # close among them. A reply it stops is reported as it ends.
    (session,) = sessions
    stopped = SimpleNamespace(prompt_tokens=0, completion_tokens=0, cancelled=True)
    await asyncio.gather(
        *(cleanup() for cleanup in ctx.cleanups),
        session.close_reporting(lambda: observer.llm_metrics(stopped)),
    )

    # The last flush comes after the session's close and the cleanup, and
    # sends the event the close reported.
    last = len(happened) - 1 - happened[::-1].index("flushed")
    ended = next(i for i, step in enumerate(happened) if step[1:2] == ("/v1/agent/session/end",))
    assert happened.index("event") < happened.index("session closed") < last
    assert ended < last
