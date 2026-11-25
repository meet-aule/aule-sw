"""How the worker lets a session in, with stand-ins for LiveKit, the platform
and both providers: no network and no paid calls."""

import asyncio
import inspect
import json
import sys
from types import SimpleNamespace

import pytest
from livekit.agents import AgentSession, llm

from aule_agent import worker
from aule_agent.config import Settings
from aule_agent.greetings import greeting
from aule_agent.moderation import PROBE_TEXT, THRESHOLDS, Moderator, Probe
from aule_agent.physical_safety import PhysicalSafetyGuard
from aule_agent.platform import Platform, PlatformSession, Refused
from aule_agent.replies import reply
from aule_agent.safety import Gates
from aule_agent.tutor import Tutor

SETTINGS = Settings(
    agent_name="a",
    stt="deepgram",
    tts="cartesia",
    tts_voice=None,
    llm_model="m",
    language="es",
    session_max_minutes=15,
    push_to_talk=False,
    openai_api_key="sk-synthetic",
    typesafe_api_key="ts-synthetic",
)
# A whole environment for a worker, made up.
ENV = {
    "LIVEKIT_URL": "ws://127.0.0.1:7880",
    "LIVEKIT_API_KEY": "key",
    "LIVEKIT_API_SECRET": "secret",
    "ANTHROPIC_API_KEY": "sk-test",
    "AULE_STT": "deepgram",
    "DEEPGRAM_API_KEY": "dg",
    "AULE_TTS": "cartesia",
    "CARTESIA_API_KEY": "car",
    "OPENAI_API_KEY": "sk-synthetic",
    "TYPESAFE_API_KEY": "ts-synthetic",
}
START = "/v1/agent/session"
END = "/v1/agent/session/end"


class Context:
    """Stands in for LiveKit's job context and records what is done with it."""

    def __init__(self, events, *, fails=None, joins=True):
        self.events = events
        self.fails = fails
        self.joins = joins
        self.room = SimpleNamespace(name="session-synthetic")
        self.job = SimpleNamespace(room=SimpleNamespace(name="session-synthetic"))

    async def wait_for_participant(self):
        # The person is in the room unless a test says nobody comes; LiveKit
        # raises when the room closes first.
        if not self.joins:
            self.events.append("nobody_joined")
            raise RuntimeError("the room closed before anyone joined")
        return SimpleNamespace(identity="guardian-synthetic")

    async def connect(self):
        self.events.append("connect")
        if self.fails is not None:
            raise self.fails

    async def delete_room(self, name):
        self.events.append(("delete_room", name))

    def shutdown(self, reason=""):
        self.events.append(("shutdown", reason))


class Answers:
    """Stands in for the platform: answers the start and records every call."""

    def __init__(self, events, start, *, asked=None, wait=None):
        self.events = events
        self.start = start
        self.asked = asked
        self.wait = wait

    async def __call__(self, method, path, body, timeout):
        self.events.append(("platform", method, path, body))
        if path != START:
            return {}
        if self.asked is not None:
            self.asked.set()
        if self.wait is not None:
            await self.wait.wait()
        if isinstance(self.start, Exception):
            raise self.start
        return self.start


def platform(events, start=None, **options):
    session = PlatformSession(url="http://platform", token="t")
    return Platform(session, Answers(events, {} if start is None else start, **options))


class Gate:
    """Stands in for one gate: whether its provider answers, and what it is told."""

    def __init__(self, events, name, probe=Probe.ANSWERS, *, started=None, wait=None):
        self.events = events
        self.name = name
        self.answer = probe
        self.started = started
        self.wait = wait

    async def probe(self):
        self.events.append(("probe", self.name))
        if self.started is not None:
            self.started.set()
        if self.wait is not None:
            await self.wait.wait()
        return self.answer

    def for_student(self, age, grade, name=None):
        self.events.append(("for_student", age, grade, name))

    async def close(self):
        self.events.append(("close", self.name))


def with_gates(monkeypatch, *, moderation=None, physical=None):
    monkeypatch.setattr(
        worker,
        "build_gates",
        lambda settings, report=None: Gates(
            moderation=moderation, physical_safety=physical, report=report
        ),
    )


def names(events):
    return [event[0] if isinstance(event, tuple) else event for event in events]


@pytest.fixture
def events():
    return []


@pytest.fixture
def refused(monkeypatch, events):
    """Records a refusal instead of saying it."""

    async def refuse(ctx, settings, language, platform):
        events.append(("refuse", language))

    monkeypatch.setattr(worker, "refuse", refuse)


async def test_a_child_session_without_both_gates_is_refused_before_anything_else(
    monkeypatch, events, refused
):
    with_gates(monkeypatch, moderation=Gate(events, "moderation"))

    admitted = await worker.admit(Context(events), SETTINGS, "child", "es", platform(events))

    assert admitted is None
    assert events == [("close", "moderation"), ("refuse", "es")]


async def test_a_child_session_starts_when_both_gates_answer_and_learns_the_students_age(
    monkeypatch, events, refused
):
    with_gates(
        monkeypatch,
        moderation=Gate(events, "moderation"),
        physical=Gate(events, "physical_safety"),
    )
    start = {
        "instructions": "Plan",
        "student_name": "Liam",
        "student_age": 9,
        "student_grade": "P4",
    }

    admitted = await worker.admit(Context(events), SETTINGS, "child", "es", platform(events, start))

    assert admitted is not None
    gates, context = admitted
    assert context == "Plan" and gates.complete
    assert sorted(names(events)) == ["connect", "for_student", "platform", "probe", "probe"]
    # The age goes to the gate once the platform has said it, with the name
    # for the gate to leave out of what it sends.
    assert events[-1] == ("for_student", 9, "P4", "Liam")


async def test_the_gates_are_asked_while_the_room_is_joined_and_the_platform_asked(
    monkeypatch, events, refused
):
    # Each side waits for the other to have begun: only asking them at once ends.
    asked, probing = asyncio.Event(), asyncio.Event()
    with_gates(
        monkeypatch,
        moderation=Gate(events, "moderation", started=probing, wait=asked),
        physical=Gate(events, "physical_safety"),
    )

    async with asyncio.timeout(2):
        admitted = await worker.admit(
            Context(events), SETTINGS, "child", "es", platform(events, asked=asked, wait=probing)
        )

    assert admitted is not None


@pytest.mark.parametrize("probe", [Probe.KEY_REFUSED, Probe.UNREACHABLE, Probe.UNEXPECTED])
async def test_a_child_session_whose_gate_does_not_answer_is_refused(
    monkeypatch, events, refused, probe
):
    with_gates(
        monkeypatch,
        moderation=Gate(events, "moderation"),
        physical=Gate(events, "physical_safety", probe),
    )

    admitted = await worker.admit(
        Context(events), SETTINGS, "child", "en", platform(events, {"student_age": 9})
    )

    assert admitted is None
    assert events[-3:] == [("close", "moderation"), ("close", "physical_safety"), ("refuse", "en")]
    assert "for_student" not in names(events)


async def test_an_operator_session_does_not_wait_for_the_gates(monkeypatch, events, refused):
    with_gates(monkeypatch, physical=Gate(events, "physical_safety", Probe.UNREACHABLE))

    admitted = await worker.admit(Context(events), SETTINGS, "operator", "es", None)

    assert admitted is not None
    assert events == ["connect"]


async def test_a_session_the_platform_no_longer_serves_ends_without_a_word(
    monkeypatch, events, refused
):
    with_gates(
        monkeypatch,
        moderation=Gate(events, "moderation"),
        physical=Gate(events, "physical_safety"),
    )

    admitted = await worker.admit(
        Context(events), SETTINGS, "child", "es", platform(events, Refused(410))
    )

    assert admitted is None
    assert "refuse" not in names(events)
    assert events[-1] == ("shutdown", "the platform no longer serves this session")


async def test_a_room_that_cannot_be_joined_stops_the_check_and_closes_the_gates(
    monkeypatch, events, refused
):
    with_gates(
        monkeypatch,
        moderation=Gate(events, "moderation", wait=asyncio.Event()),
        physical=Gate(events, "physical_safety"),
    )

    with pytest.raises(RuntimeError):
        await worker.admit(
            Context(events, fails=RuntimeError("no room")), SETTINGS, "child", "es", None
        )
    await asyncio.sleep(0)

    assert {("close", "moderation"), ("close", "physical_safety")} <= set(events)
    assert [task for task in asyncio.all_tasks() if task is not asyncio.current_task()] == []


class OpenAI:
    """Stands in for the moderation provider's client: nothing is in any category."""

    def __init__(self):
        names = [category.replace("/", "_").replace("-", "_") for category in THRESHOLDS]
        result = SimpleNamespace(
            flagged=False,
            category_scores=SimpleNamespace(**dict.fromkeys(names, 0.0)),
            categories=SimpleNamespace(**dict.fromkeys(names, False)),
        )
        self.answer = SimpleNamespace(results=[result])
        self.moderations = SimpleNamespace(create=self.create)
        self.inputs = []

    async def create(self, *, model, input):
        self.inputs.append(input)
        return self.answer

    async def close(self):
        pass


async def test_the_platforms_age_reaches_the_physical_safety_gate_and_the_name_never_does(
    monkeypatch, events, refused
):
    sent = []

    async def send(body):
        sent.append(body.decode())
        answer = {"model": "jev-1.14.0", "answers": {"needs_adult": {"type": "noul", "noul": 0.01}}}
        return json.dumps(answer).encode()

    async def list_models():
        return (
            b'{"models": [{"name": "jev-latest", "description": "", "release_date": "2026-09-15"}]}'
        )

    client = OpenAI()
    gates = Gates(
        moderation=Moderator("sk-synthetic", client=client),
        physical_safety=PhysicalSafetyGuard("ts-synthetic", send=send, list_models=list_models),
    )
    monkeypatch.setattr(worker, "build_gates", lambda settings, report=None: gates)
    start = {
        "instructions": "The student's name is Liam.",
        "student_name": "Liam",
        "student_age": 9,
        "student_grade": "P4",
    }

    admitted = await worker.admit(Context(events), SETTINGS, "child", "es", platform(events, start))
    assert admitted is not None
    # The conversation so far, as the tutor opens it: a greeting with the name.
    conversation = llm.ChatContext.empty()
    conversation.add_message(role="assistant", content=greeting("es", "Aule", "Liam", 0))
    said = llm.ChatMessage(role="user", content=["¿Puedo usar las tijeras de la cocina?"])
    decision = await gates.heard(conversation, said)
    await gates.close()

    assert decision.allowed
    assert client.inputs[0] == PROBE_TEXT
    (body,) = [json.loads(body) for body in sent]
    assert body["state"]["age"] == 9
    assert body["state"]["history"] == [
        {"role": "assistant", "content": greeting("es", "Aule", "[student]", 0)}
    ]
    assert "Liam" not in json.dumps(body)


def livekits(method, *args, **options):
    """Fails when LiveKit's own ``method`` would not take these arguments."""
    inspect.signature(method).bind(None, *args, **options)


def voice(events, *, fails=None):
    """Stands in for LiveKit's AgentSession in a refused session."""

    class Voice:
        def __init__(self, **options):
            livekits(AgentSession.__init__, **options)
            events.append(("voice", options))

        async def start(self, *, agent, room, room_options, session_host, record):
            livekits(
                AgentSession.start,
                agent,
                room=room,
                room_options=room_options,
                session_host=session_host,
                record=record,
            )
            inputs = (room_options.audio_input, room_options.text_input, room_options.video_input)
            events.append(("start", inputs, session_host, record))
            if fails == "start":
                raise RuntimeError("synthetic")

        def say(self, text, *, allow_interruptions, add_to_chat_ctx):
            livekits(
                AgentSession.say,
                text,
                allow_interruptions=allow_interruptions,
                add_to_chat_ctx=add_to_chat_ctx,
            )
            events.append(("say", text, allow_interruptions, add_to_chat_ctx))
            if fails == "say":
                raise RuntimeError("synthetic")

            async def played():
                if fails == "nobody_listens":
                    await asyncio.sleep(5)

            return played()

        async def aclose(self):
            events.append("aclose")
            if fails == "aclose":
                raise RuntimeError("synthetic")

    return Voice


@pytest.mark.parametrize("language", ["es", "en"])
async def test_a_refused_session_says_the_fixed_line_and_tells_the_platform(
    monkeypatch, events, language
):
    monkeypatch.setattr(worker, "AgentSession", voice(events))
    monkeypatch.setattr(worker, "build_tts", lambda settings, language: f"voice-{language}")

    await worker.refuse(Context(events), SETTINGS, language, platform(events))

    assert events == [
        "connect",
        # A voice and nothing else: no model, no speech recognition.
        (
            "voice",
            {
                "tts": f"voice-{language}",
                "vad": None,
                "turn_handling": {"turn_detection": "manual"},
            },
        ),
        # Nothing the child says, types or shows is read, nobody in the room
        # can drive the session, and nothing is recorded.
        ("start", (False, False, False), False, False),
        ("say", reply("unavailable", language), False, False),
        # The platform knows why before the page loses its room, so the end screen says it.
        ("platform", "POST", END, {"end_reason": "provider_error"}),
        "aclose",
        ("delete_room", "session-synthetic"),
        ("shutdown", "the safety gates are not ready"),
    ]


async def test_a_refused_session_nobody_joins_ends_without_a_word(monkeypatch, events):
    # The platform opens the room before the person joins it: with nobody to
    # hear it, no voice starts, and the session still ends for the platform.
    monkeypatch.setattr(worker, "AgentSession", voice(events))
    monkeypatch.setattr(worker, "build_tts", lambda settings, language: "voice")

    await worker.refuse(Context(events, joins=False), SETTINGS, "es", platform(events))

    assert events == [
        "connect",
        "nobody_joined",
        ("platform", "POST", END, {"end_reason": "provider_error"}),
        ("delete_room", "session-synthetic"),
        ("shutdown", "the safety gates are not ready"),
    ]


@pytest.mark.parametrize("fails", ["start", "say", "nobody_listens"])
async def test_a_refused_session_ends_even_when_its_line_cannot_be_said(monkeypatch, events, fails):
    monkeypatch.setattr(worker, "REFUSAL_SECONDS", 0.01)
    monkeypatch.setattr(worker, "AgentSession", voice(events, fails=fails))
    monkeypatch.setattr(worker, "build_tts", lambda settings, language: "voice")

    await worker.refuse(Context(events), SETTINGS, "es", platform(events))

    assert events[-4:] == [
        ("platform", "POST", END, {"end_reason": "provider_error"}),
        "aclose",
        ("delete_room", "session-synthetic"),
        ("shutdown", "the safety gates are not ready"),
    ]


async def test_a_voice_that_fails_to_close_still_leaves_the_room_closed(monkeypatch, events):
    monkeypatch.setattr(worker, "AgentSession", voice(events, fails="aclose"))
    monkeypatch.setattr(worker, "build_tts", lambda settings, language: "voice")

    with pytest.raises(RuntimeError):
        await worker.refuse(Context(events), SETTINGS, "es", platform(events))

    assert events[-2:] == [
        ("delete_room", "session-synthetic"),
        ("shutdown", "the safety gates are not ready"),
    ]


async def test_a_refused_session_without_a_voice_or_a_platform_still_closes_its_room(
    monkeypatch, events
):
    def no_voice(settings, language):
        raise RuntimeError("synthetic")

    monkeypatch.setattr(worker, "build_tts", no_voice)

    await worker.refuse(Context(events), SETTINGS, "es", None)

    assert events == [
        "connect",
        ("delete_room", "session-synthetic"),
        ("shutdown", "the safety gates are not ready"),
    ]


class Local:
    """Stands in for the agent's own participant in the room."""

    def __init__(self):
        self.rpcs = {}
        self.attributes = {}

    def register_rpc_method(self, name, handler):
        self.rpcs[name] = handler

    async def set_attributes(self, attributes):
        self.attributes.update(attributes)


class Room:
    """Stands in for LiveKit's room: nobody else in it yet."""

    def __init__(self):
        self.name = "session-synthetic"
        self.remote_participants = {}
        self.local_participant = Local()

    def on(self, event, callback):
        pass

    def off(self, event, callback):
        pass


def started(sessions):
    """Stands in for LiveKit's AgentSession in a session that starts."""

    class Session:
        agent_state = "listening"

        def __init__(self, **options):
            livekits(AgentSession.__init__, **options)
            self.options = options
            self.start_options = None
            sessions.append(self)

        def on(self, event, callback=None):
            return callback if callback is not None else (lambda handler: handler)

        async def start(self, **options):
            livekits(AgentSession.start, **options)
            self.start_options = options

    return Session


@pytest.mark.parametrize("audience", ["child", "operator"])
async def test_an_admitted_session_starts_with_no_way_around_the_gates(monkeypatch, audience):
    sessions, shutdown = [], []
    for name, value in ENV.items():
        monkeypatch.setenv(name, value)

    async def admit(ctx, settings, who, language, platform):
        assert (who, language, platform) == (audience, "es", None)
        return Gates(), ""

    provider = SimpleNamespace(on=lambda event, callback: None)
    monkeypatch.setattr(worker, "admit", admit)
    monkeypatch.setattr(worker, "AgentSession", started(sessions))
    monkeypatch.setattr(worker, "build_llm", lambda settings: provider)
    monkeypatch.setattr(worker, "build_stt", lambda settings, language: provider)
    monkeypatch.setattr(worker, "build_tts", lambda settings, language: provider)
    room = Room()
    ctx = SimpleNamespace(
        job=SimpleNamespace(
            metadata=json.dumps({"audience": audience} if audience == "operator" else {}),
            room=SimpleNamespace(name=room.name),
        ),
        room=room,
        proc=SimpleNamespace(userdata={"vad": "vad"}),
        add_shutdown_callback=shutdown.append,
    )

    await worker.entrypoint(ctx)
    try:
        (session,) = sessions
        options = session.start_options
        # LiveKit's session host would let anyone in the room give the model
        # text that no gate reads, and read the tutor's instructions.
        assert options["session_host"] is False
        assert options["record"] is False
        assert isinstance(options["agent"], Tutor)
        # What is typed goes to the tutor, which judges it, and not to the model.
        assert options["room_options"].text_input.text_input_cb is not None
        assert options["room_options"].video_input is False
        assert options["room_options"].close_on_disconnect is (audience == "operator")
        assert set(room.local_participant.rpcs) == {"show_work", "answered"}
    finally:
        for cleanup in shutdown:
            await cleanup()


async def test_the_start_up_check_asks_the_gates_with_the_workers_settings(monkeypatch):
    seen = []

    async def check(settings):
        seen.append(settings.typesafe_api_key)
        return False

    monkeypatch.setattr(worker, "check_at_start", check)
    for name, value in ENV.items():
        monkeypatch.setenv(name, value)

    await worker.check_gates()

    assert seen == ["ts-synthetic"]


async def test_a_worker_without_its_settings_asks_the_gates_nothing(monkeypatch):
    async def check(settings):
        raise AssertionError("asked the gates")

    monkeypatch.setattr(worker, "check_at_start", check)
    for name in ENV:
        monkeypatch.delenv(name, raising=False)

    await worker.check_gates()


@pytest.mark.parametrize(("ready", "code"), [(True, 0), (False, 1)])
def test_the_check_command_says_whether_a_childs_session_could_start(monkeypatch, ready, code):
    async def check(settings):
        return ready

    def run_app(server):
        raise AssertionError("joined LiveKit")

    monkeypatch.setattr(worker, "check_at_start", check)
    monkeypatch.setattr(worker.cli, "run_app", run_app)
    monkeypatch.setattr(sys, "argv", ["aule-agent", "check"])
    for name, value in ENV.items():
        monkeypatch.setenv(name, value)

    with pytest.raises(SystemExit) as exited:
        worker.main()

    assert exited.value.code == code
