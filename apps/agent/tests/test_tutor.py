import asyncio
import json
import time
from types import SimpleNamespace
from unittest.mock import PropertyMock, patch

import pytest
from livekit import rtc
from livekit.agents import Agent, StopResponse, llm, stt

from aule_agent.greetings import GREETINGS, greeting
from aule_agent.moderation import Action, Decision
from aule_agent.prompts import RESPONSE_LANGUAGES, response_language
from aule_agent.replies import ADULT_HELP_SEQUENCE, MEANWHILE, REPLIES, reply
from aule_agent.script import Line, Reply
from aule_agent.timing import Timing
from aule_agent.tutor import (
    FRESH_FRAME_SECONDS,
    INSTRUCTIONS,
    MAX_TYPED_CHARS,
    UNCHECKED,
    UNCUT_WAIT_SECONDS,
    Persona,
    Tutor,
    checked,
    persona_from,
    persona_notes,
    shows_something,
    with_frame,
)
from aule_agent.worker import language_of, persona_of


@pytest.fixture(autouse=True)
def no_waiting_for_a_missing_reply(monkeypatch):
    monkeypatch.setattr("aule_agent.tutor.NO_REPLY_SECONDS", 0)


def frame():
    return rtc.VideoFrame(2, 2, rtc.VideoBufferType.RGBA, bytes(16))


def context():
    chat_ctx = llm.ChatContext()
    chat_ctx.add_message(role="user", content="mira mi cuaderno")
    chat_ctx.add_message(role="assistant", content="¿qué intentaste?")
    chat_ctx.add_message(role="user", content="esto")
    return chat_ctx


def images(message):
    return [part for part in message.content if isinstance(part, llm.ImageContent)]


def test_the_frame_goes_on_the_last_user_message_only():
    seen = with_frame(context(), frame())

    first, _, last = seen.items
    assert images(first) == []
    assert len(images(last)) == 1
    assert last.text_content == "esto"


def test_the_session_history_is_left_without_images():
    chat_ctx = context()

    with_frame(chat_ctx, frame())

    assert all(images(item) == [] for item in chat_ctx.items)


def test_without_a_frame_or_a_user_message_the_context_is_unchanged():
    chat_ctx = context()
    assert with_frame(chat_ctx, None) is chat_ctx

    empty = llm.ChatContext()
    assert with_frame(empty, frame()) is empty


def test_every_language_has_its_texts():
    assert set(RESPONSE_LANGUAGES) == {"es", "en"}


def test_language_comes_from_the_dispatch_when_supported():
    assert language_of('{"language": "en"}', "es") == "en"
    assert language_of('{"language": "fr"}', "es") == "es"
    assert language_of("not json", "es") == "es"
    assert language_of("", "en") == "en"


class ScriptedGates:
    """Stands in for the gates: answers each turn with the next decision."""

    checks_spoken = True

    def __init__(self, *decisions):
        self.decisions = list(decisions)
        self.heard_texts = []
        self.spoken_texts = []

    async def heard(self, context, message):
        self.heard_texts.append(message.text_content)
        return self.decisions.pop(0)

    async def spoken(self, text):
        self.spoken_texts.append(text)
        return self.decisions.pop(0)


class Session:
    """Records what the tutor says outside the model, as the voice would."""

    def __init__(self):
        self.said = []
        self.interrupted = False
        # What the voice is saying now; nothing between lines.
        self.current_speech = None
        # Waits, interruptions and replies, in the order they happened.
        self.order = []

    def interrupt(self):
        speech = self.current_speech
        if speech is not None and not speech.done() and not speech.allow_interruptions:
            # As livekit-agents does while a line said with allow_interruptions=False plays.
            raise RuntimeError("This generation handle does not allow interruptions")
        self.interrupts = getattr(self, "interrupts", 0) + 1
        self.order.append("interrupt")

        async def done():
            return None

        return done()

    def generate_reply(self, *, user_input):
        self.replies_to = [*getattr(self, "replies_to", []), user_input]
        self.order.append("reply")

    def say(self, text, *, add_to_chat_ctx, allow_interruptions):
        self.said.append((text, add_to_chat_ctx, allow_interruptions))

        async def played():
            return SimpleNamespace(interrupted=self.interrupted)

        return played()


class Speaking:
    """A line the voice is saying. One said with allow_interruptions=False cannot be cut."""

    def __init__(self, session, *, allow_interruptions=False, then=None):
        self.session, self.allow_interruptions, self.then = session, allow_interruptions, then
        self.finished = False

    def done(self):
        return self.finished

    async def wait_for_playout(self):
        self.session.order.append("played out")
        self.finished = True
        self.session.current_speech = self.then


class Endless(Speaking):
    """A line that cannot be cut and goes on for longer than anyone waits."""

    async def wait_for_playout(self):
        await asyncio.Event().wait()


ALLOW = Decision(Action.ALLOW)
HAZARD = Decision(Action.REDIRECT, "adult_help")


async def hear(tutor, session, text="¿lo desenchufo?"):
    """One turn of the person. True when the tutor may answer it."""
    message = llm.ChatMessage(role="user", content=[text])
    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
        try:
            await tutor.on_user_turn_completed(llm.ChatContext.empty(), message)
        except StopResponse:
            return False
    return True


async def stream(*chunks):
    for chunk in chunks:
        yield chunk


async def test_an_allowed_turn_goes_to_the_model_and_nothing_else_is_said():
    gates, session = ScriptedGates(ALLOW), Session()

    assert await hear(Tutor(language="es", gates=gates), session)
    assert session.said == []


@pytest.mark.parametrize(
    ("decision", "kept"),
    [
        (Decision(Action.REDIRECT, "redirect"), False),
        (Decision(Action.SUPPORT, "self_harm_support"), False),
        (Decision(Action.SUPPORT, "child_support"), False),
        (Decision(Action.UNAVAILABLE, "unavailable"), False),
        (Decision(Action.UNAVAILABLE, "context_limit"), False),
        # An offer stays in the conversation so the next answer can refer to it.
        (Decision(Action.REDIRECT, "clarify"), True),
        (HAZARD, True),
    ],
)
@pytest.mark.parametrize("language", ["es", "en"])
async def test_a_stopped_turn_gets_the_fixed_reply_and_never_reaches_the_model(
    decision, kept, language
):
    gates, session = ScriptedGates(decision), Session()

    assert not await hear(Tutor(language=language, gates=gates), session)
    assert session.said == [(REPLIES[decision.reply][language], kept, False)]


async def test_hazards_in_a_row_get_the_full_offer_and_then_shorter_reminders():
    gates, session = ScriptedGates(HAZARD, HAZARD, HAZARD, HAZARD, ALLOW, HAZARD), Session()
    tutor = Tutor(language="es", gates=gates)

    for _ in range(6):
        await hear(tutor, session)

    keys = ["adult_help", "adult_help_again", "adult_help_wait", "adult_help_again"]
    assert [said[0] for said in session.said] == [
        REPLIES[key]["es"]
        for key in [*keys, "adult_help"]  # a safe turn starts over
    ]


async def test_a_reminder_that_was_not_heard_in_full_is_not_counted():
    gates, session = ScriptedGates(HAZARD, HAZARD), Session()
    session.interrupted = True
    tutor = Tutor(language="en", gates=gates)

    await hear(tutor, session)
    await hear(tutor, session)

    assert [said[0] for said in session.said] == [REPLIES["adult_help"]["en"]] * 2


async def test_a_reply_is_held_until_all_of_it_has_passed():
    gates = ScriptedGates(ALLOW)
    released = []

    async def model():
        yield "Muy "
        assert released == []  # nothing is spoken while the model is still writing
        yield llm.ChatChunk(id="1", delta=llm.ChoiceDelta(role="assistant", content="bien."))

    async for chunk in checked(model(), gates, "es"):
        released.append(chunk)

    assert gates.spoken_texts == ["Muy bien."]
    assert [getattr(chunk, "id", chunk) for chunk in released] == ["Muy ", "1"]


@pytest.mark.parametrize("key", ["redirect", "unavailable"])
async def test_a_reply_that_does_not_pass_is_replaced_whole(key):
    gates = ScriptedGates(Decision(Action.REDIRECT, key))

    spoken = [chunk async for chunk in checked(stream("algo ", "indebido"), gates, "en")]

    assert spoken == [REPLIES[key]["en"]]


def test_persona_falls_back_to_the_defaults():
    assert persona_from("Luna", "jugueton", " sé breve ") == Persona("Luna", "jugueton", "sé breve")
    # An unknown preset becomes calido, a blank name becomes Aule, a blank note None.
    assert persona_from("  ", "unknown", "   ") == Persona("Aule", "calido", None)
    assert persona_from(None, None, None) == Persona()


def test_persona_of_reads_the_dispatch_metadata():
    meta = '{"tutor_name": "Río", "tutor_persona": "aventurero", "tutor_persona_note": "fútbol"}'
    assert persona_of(meta) == Persona("Río", "aventurero", "fútbol")
    assert persona_of("") == Persona()
    assert persona_of("not json") == Persona()


def test_persona_notes_add_nothing_by_default_and_a_bounded_wish_with_a_note():
    assert persona_notes(Persona()) == ""
    assert "playful" in persona_notes(Persona(preset="jugueton"))
    wish = persona_notes(Persona(note="habla despacio"))
    assert "habla despacio" in wish and "safety" in wish


def test_a_named_persona_renames_the_tutor_and_the_default_leaves_the_prompt_as_written():
    default = Tutor(language="es", gates=ScriptedGates(ALLOW))
    assert default._base == INSTRUCTIONS
    assert default._tutor_name == "Aule"

    named = Tutor(
        language="es", gates=ScriptedGates(ALLOW), persona=Persona(name="Luna", preset="jugueton")
    )
    assert 'Tutor display name (data): "Luna"' in named._base
    assert named._tutor_name == "Luna"
    # The name is data and the preset follows the teaching policy.
    assert named._base.rstrip().endswith("fun tone.")


async def type_to(tutor, session, text):
    empty = llm.ChatContext.empty()
    with (
        patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session),
        patch.object(Tutor, "chat_ctx", new_callable=PropertyMock, return_value=empty),
    ):
        await tutor.typed(text)


async def test_a_goodbye_closes_the_session_instead_of_reaching_the_model():
    gates, session = ScriptedGates(ALLOW, ALLOW, ALLOW), Session()
    tutor = Tutor(language="es", gates=gates)
    closed = []
    tutor.on_goodbye = lambda: closed.append("closed")

    assert not await hear(tutor, session, "bueno, chau Aule")
    await type_to(tutor, session, "ya me voy")
    assert await hear(tutor, session, "me voy a equivocar")

    assert closed == ["closed", "closed"]
    assert not hasattr(session, "replies_to")


async def test_a_typed_message_is_judged_like_a_spoken_one_before_the_model_sees_it():
    gates, session = ScriptedGates(ALLOW), Session()

    await type_to(Tutor(language="es", gates=gates), session, "  ¿cuánto es 3/4 + 1/8?  ")

    assert gates.heard_texts == ["¿cuánto es 3/4 + 1/8?"]
    assert session.replies_to == ["¿cuánto es 3/4 + 1/8?"]
    assert session.interrupts == 1
    assert session.said == []


@pytest.mark.parametrize("decision", [HAZARD, Decision(Action.REDIRECT, "redirect")])
async def test_a_typed_message_the_gates_stop_never_reaches_the_model(decision):
    gates, session = ScriptedGates(decision), Session()

    await type_to(Tutor(language="es", gates=gates), session, "¿lo desenchufo?")

    assert not hasattr(session, "replies_to")
    key = ADULT_HELP_SEQUENCE[0] if decision is HAZARD else "redirect"
    assert [said[0] for said in session.said] == [reply(key, "es")]


async def test_a_message_typed_while_a_line_that_cannot_be_cut_is_said_waits_for_it_to_end():
    # A gate's reply, "unavailable" or pace's lines are said with allow_interruptions=False.
    # Interrupting one raises, and the message the page already shows as sent was lost.
    gates, session = ScriptedGates(ALLOW), Session()
    session.current_speech = Speaking(session)

    await type_to(Tutor(language="es", gates=gates), session, "¿y 2/3 + 1/3?")

    assert session.order == ["played out", "interrupt", "reply"]
    # Judged and answered once, after the line.
    assert gates.heard_texts == ["¿y 2/3 + 1/3?"]
    assert session.replies_to == ["¿y 2/3 + 1/3?"]
    assert session.interrupts == 1


async def test_a_typed_message_waits_for_each_line_that_cannot_be_cut_and_still_passes_the_gates():
    gates, session = ScriptedGates(Decision(Action.REDIRECT, "redirect")), Session()
    session.current_speech = Speaking(session, then=Speaking(session))

    await type_to(Tutor(language="es", gates=gates), session, "¿lo desenchufo?")

    assert session.order == ["played out", "played out", "interrupt"]
    assert gates.heard_texts == ["¿lo desenchufo?"]
    assert not hasattr(session, "replies_to")
    assert [said[0] for said in session.said] == [reply("redirect", "es")]


async def test_a_line_that_may_be_cut_is_cut_at_once_for_a_typed_message():
    gates, session = ScriptedGates(ALLOW), Session()
    speaking = Speaking(session, allow_interruptions=True)
    session.current_speech = speaking

    await type_to(Tutor(language="es", gates=gates), session, "espera")

    assert session.order == ["interrupt", "reply"]
    assert not speaking.finished


async def test_an_empty_typed_message_is_ignored_and_a_long_one_is_cut():
    gates, session = ScriptedGates(ALLOW), Session()
    tutor = Tutor(language="es", gates=gates)

    await type_to(tutor, session, "   ")
    assert gates.heard_texts == []
    assert not hasattr(session, "interrupts")

    await type_to(tutor, session, "a" * 2000)
    assert [len(text) for text in gates.heard_texts] == [MAX_TYPED_CHARS]
    assert [len(text) for text in session.replies_to] == [MAX_TYPED_CHARS]


class ScriptedChecker:
    """Stands in for the platform's exercise checker."""

    def __init__(self, posed=None, judged=None):
        self.posed, self.judged, self.calls = posed, judged, []

    async def pose(self, expression, skill_id, form):
        self.calls.append(("pose", expression, skill_id, form))
        return self.posed

    async def answer(self, said):
        self.calls.append(("answer", said))
        return self.judged


def tool(tutor, name):
    return next(tool for tool in tutor.tools if tool.info.name == name)


def test_the_checking_tools_exist_only_with_something_to_check_with():
    plain = Tutor(language="es", gates=ScriptedGates())
    checking = Tutor(language="es", gates=ScriptedGates(), checker=ScriptedChecker())

    drill = ["pose_phrase", "check_phrase"]
    assert [tool.info.name for tool in plain.tools] == ["compare_numbers", *drill]
    assert "pose_exercise" not in plain.instructions
    assert [tool.info.name for tool in checking.tools] == [
        "compare_numbers",
        "pose_exercise",
        "check_answer",
        *drill,
    ]
    assert "pose_exercise" in checking.instructions


async def test_the_model_is_told_what_the_checker_said_and_nothing_else():
    checker = ScriptedChecker(posed="Ask it and wait.", judged="Give one hint about the sign.")
    tutor = Tutor(language="es", gates=ScriptedGates(), checker=checker)

    assert await tool(tutor, "pose_exercise")({"expression": "3/4 + 1/8"}) == "Ask it and wait."
    assert await tool(tutor, "check_answer")({"said": "me da cuatro doceavos"}) == (
        "Give one hint about the sign."
    )
    assert checker.calls == [
        ("pose", "3/4 + 1/8", None, None),
        ("answer", "me da cuatro doceavos"),
    ]


async def test_an_exercise_that_cannot_be_checked_leaves_the_tutor_on_its_own():
    tutor = Tutor(language="en", gates=ScriptedGates(), checker=ScriptedChecker())

    assert await tool(tutor, "pose_exercise")({"expression": "which is bigger?"}) == UNCHECKED
    assert await tool(tutor, "check_answer")({"said": "the red one"}) == UNCHECKED


def nullable(schema):
    """Every place a tool schema declares a value that may be null."""
    if isinstance(schema, dict):
        kind = schema.get("type")
        here = kind == "null" or (isinstance(kind, list) and "null" in kind)
        return here or any(nullable(value) for value in schema.values())
    return isinstance(schema, list) and any(nullable(item) for item in schema)


def test_no_tool_declares_a_nullable_argument_which_the_model_api_refuses_with_an_enum():
    tutor = Tutor(
        language="es", gates=ScriptedGates(), checker=ScriptedChecker(), show=lambda visual: None
    )

    assert len(tutor.tools) == 6
    for each in tutor.tools:
        assert not nullable(each.info.raw_schema), each.info.name


async def test_a_checking_call_without_its_text_is_not_sent_to_the_platform():
    checker = ScriptedChecker(posed="x", judged="y")
    tutor = Tutor(language="es", gates=ScriptedGates(), checker=checker)

    assert await tool(tutor, "pose_exercise")({"skill_id": "a.b"}) == UNCHECKED
    assert await tool(tutor, "check_answer")({"said": 7}) == UNCHECKED
    assert checker.calls == []


async def test_an_accepted_turn_without_a_reply_is_reported(caplog):
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW))
    session = Session()
    session.agent_state = "listening"

    with caplog.at_level("WARNING", logger="aule.agent.tutor"):
        assert await hear(tutor, session)
        with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
            await asyncio.gather(*tutor._watches)

    assert [record.message for record in caplog.records] == ["no reply after an accepted turn"]
    assert caplog.records[0].model_answered is False


async def test_an_answered_turn_is_not_reported(caplog):
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW))
    session = Session()
    session.agent_state = "speaking"

    with caplog.at_level("WARNING", logger="aule.agent.tutor"):
        assert await hear(tutor, session)
        tutor._model_done_at = time.monotonic()
        with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
            await asyncio.gather(*tutor._watches)

    assert caplog.records == []


async def test_a_late_plan_joins_the_student_context_and_keeps_the_guidance():
    tutor = Tutor(
        language="es",
        gates=ScriptedGates(),
        context="The student is Liam.",
        persona=persona_from("Aule", "jugueton", None),
    )
    seen: list[str] = []

    async def update(instructions):
        seen.append(instructions)

    with patch.object(Tutor, "update_instructions", side_effect=update):
        await tutor.advise("Slow down.")
        await tutor.plan("Plan: fractions.")

    final = seen[-1]
    assert final.index("The student is Liam.") < final.index("Plan: fractions.")
    assert final.index("Plan: fractions.") < final.index("fun tone.") < final.index("Slow down.")


@pytest.mark.parametrize(
    "first, second",
    [
        (
            "Imagina dos pizzas cortadas en mitades. ¿Cuántos pedazos hay?",
            "Ahora dime si eso es multiplicar o dividir por un medio.",
        ),
        (
            "Let's use pizza. Say you have two whole pizzas, cut into halves.",
            "Then tell me, is that two times one half, or two divided by one half?",
        ),
    ],
)
async def test_all_instructional_paragraphs_are_judged_and_spoken(first: str, second: str) -> None:
    gates = ScriptedGates(ALLOW)
    metadata = llm.ChatChunk(id="usage")
    chunks = [first + "\n\n", second, metadata]

    released = [chunk async for chunk in checked(stream(*chunks), gates, "es")]

    assert gates.spoken_texts == [first + "\n\n" + second]
    assert released == chunks


@pytest.mark.parametrize("unsafe_first", [True, False])
async def test_any_blocked_paragraph_stops_the_whole_reply(unsafe_first: bool) -> None:
    gates = ScriptedGates(Decision(Action.REDIRECT, "redirect"))
    paragraphs = ["Blocked test content.", "A safe question."]
    if not unsafe_first:
        paragraphs.reverse()
    written = "\n\n".join(paragraphs)

    released = [chunk async for chunk in checked(stream(written), gates, "en")]

    assert gates.spoken_texts == [written]
    assert released == [reply("redirect", "en")]


async def test_tool_step_text_is_not_spoken_even_without_a_filler() -> None:
    gates, call = ScriptedGates(), a_call("compare_numbers")
    released = [
        chunk
        async for chunk in checked(
            stream("I should check the numbers.\n\nLet me check.", call), gates, "en"
        )
    ]
    assert released == [call]
    assert gates.spoken_texts == []


def a_call(name):
    return llm.ChatChunk(
        id=name,
        delta=llm.ChoiceDelta(
            role="assistant",
            tool_calls=[llm.FunctionToolCall(name=name, arguments="{}", call_id=name)],
        ),
    )


@pytest.mark.parametrize("tool", ["check_answer", "pose_exercise", "compare_numbers", "show"])
async def test_a_step_that_calls_a_tool_says_a_fixed_line_and_nothing_of_the_models(tool):
    gates, call = ScriptedGates(), a_call(tool)
    thinking = stream("El plan pide empezar fácil, ", "así que muestro las barras.", call)

    released = [chunk async for chunk in checked(thinking, gates, "es", lambda: "A ver.")]

    assert released == ["A ver.", call]
    # A fixed line is not the model's: there is nothing to judge.
    assert gates.spoken_texts == []


async def test_a_tool_called_without_a_word_still_gets_the_line():
    call = a_call("show")

    released = [
        chunk async for chunk in checked(stream(call), ScriptedGates(), "es", lambda: "A ver.")
    ]

    assert released == ["A ver.", call]


async def test_the_step_that_calls_nothing_is_the_reply_and_is_judged():
    gates = ScriptedGates(ALLOW)

    released = [
        c async for c in checked(stream("Muy bien, ", "sigamos."), gates, "es", lambda: "x")
    ]

    assert released == ["Muy bien, ", "sigamos."] and gates.spoken_texts == ["Muy bien, sigamos."]


async def test_one_line_per_turn_of_the_student_however_many_tools_the_turn_takes():
    gates, session = ScriptedGates(ALLOW, ALLOW), Session()
    tutor = Tutor(language="es", gates=gates)
    check, pose, show = a_call("check_answer"), a_call("pose_exercise"), a_call("show")

    async def steps(*calls):
        return [
            chunk
            for call in calls
            async for chunk in checked(stream("pienso", call), gates, "es", tutor._meanwhile)
        ]

    await hear(tutor, session, "creo que es dos")
    first = await steps(check, pose, show)
    await hear(tutor, session, "no sé")
    second = await steps(check)

    # The first tool of a turn gets the line; the ones after it work in silence.
    assert first == [REPLIES[MEANWHILE[0]]["es"], check, pose, show]
    assert second == [REPLIES[MEANWHILE[1]]["es"], check]


def test_the_lines_said_while_a_tool_works_are_short_in_both_languages():
    assert set(MEANWHILE) <= set(REPLIES)
    assert all(len(REPLIES[key][language]) <= 14 for key in MEANWHILE for language in ("es", "en"))


async def enter(tutor, session):
    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
        await tutor.on_enter()


async def test_the_session_opens_with_a_written_greeting_and_no_model():
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW), student_name="Liam", session_number=0)
    session = Session()

    await enter(tutor, session)

    assert session.said == [
        ("¡Hola, Liam! Soy Aule, qué gusto verte. Cuéntame, ¿cómo te fue hoy?", True, True)
    ]
    assert not hasattr(session, "replies_to")


async def test_a_name_the_gate_stops_is_left_out_of_the_greeting():
    stopped = ScriptedGates(Decision(Action.REDIRECT, "redirect"))
    tutor = Tutor(language="en", gates=stopped, student_name="x", session_number=1)
    session = Session()

    await enter(tutor, session)

    assert session.said == [("Hi! Aule here. What was the best part of your day?", True, True)]


def test_greetings_are_taken_in_turn_carry_the_tutors_name_and_exist_in_every_language():
    for language in ("es", "en"):
        said = [
            greeting(language, "Luna", "Liam", number) for number in range(len(GREETINGS[language]))
        ]
        assert len(set(said)) == len(GREETINGS[language])
        assert all("Luna" in text and "Liam" in text and "{" not in text for text in said)
        assert greeting(language, "Luna", None, 0) != said[0]
        assert greeting(language, "Luna", "Liam", len(said)) == said[0]
        assert greeting(language, "Luna") in [
            greeting(language, "Luna", None, number) for number in range(len(said))
        ]
    assert len(GREETINGS["es"]) == len(GREETINGS["en"]) >= 10


class ScriptedEngine:
    """Stands in for the session engine."""

    def __init__(self, opening=(), *replies):
        self._opening, self.replies, self.heard = tuple(opening), list(replies), []

    def opening(self):
        return self._opening

    async def said(self, text):
        self.heard.append(text)
        return self.replies.pop(0) if self.replies else None


async def scripted_turn(tutor, session, text="tres cuartos"):
    """One turn with the engine. True when the model is left to answer."""
    updates = {"instructions": [], "context": []}

    async def instructions(value):
        updates["instructions"].append(value)

    async def context(value):
        updates["context"].append(value)

    message = llm.ChatMessage(role="user", content=[text])
    with (
        patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session),
        patch.object(Tutor, "update_instructions", side_effect=instructions),
        patch.object(Tutor, "update_chat_ctx", side_effect=context),
    ):
        try:
            await tutor.on_user_turn_completed(llm.ChatContext.empty(), message)
        except StopResponse:
            return False, updates
    return True, updates


async def test_the_session_opens_with_the_engines_words_and_no_model():
    shown = []

    async def show(visual):
        shown.append(visual)

    drawing = {"kind": "dot_array", "rows": 2, "columns": 3}
    engine = ScriptedEngine([Line("¡Hola, Liam!"), Line("Mira el círculo.", show=drawing)])
    tutor, session = (
        Tutor(language="es", gates=ScriptedGates(), engine=engine, show=show),
        Session(),
    )

    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
        await tutor.on_enter()

    assert session.said == [("¡Hola, Liam!", True, True), ("Mira el círculo.", True, True)]
    assert shown == [drawing]
    assert not hasattr(session, "replies_to")


async def test_a_hint_from_the_engine_is_said_as_written_and_the_model_is_not_called():
    hint = Reply(lines=(Line("¿Un medio y un tercio son pedazos del mismo tamaño?"),))
    engine = ScriptedEngine([Line("hola")], hint)
    tutor, session = Tutor(language="es", gates=ScriptedGates(ALLOW), engine=engine), Session()

    to_the_model, updates = await scripted_turn(tutor, session, "cinco sextos")

    assert not to_the_model
    assert engine.heard == ["cinco sextos"]
    assert session.said == [("¿Un medio y un tercio son pedazos del mismo tamaño?", True, True)]
    # What the student said stays in the conversation.
    assert updates["context"][0].items[-1].text_content == "cinco sextos"


async def test_when_the_student_leaves_the_script_the_model_answers_within_the_rules():
    engine = ScriptedEngine(
        [Line("hola")], Reply(converse="No hints: this is a measurement."), None
    )
    tutor, session = (
        Tutor(language="es", gates=ScriptedGates(ALLOW, ALLOW), engine=engine),
        Session(),
    )

    asked, first = await scripted_turn(tutor, session, "¿qué es un denominador?")
    off_script, second = await scripted_turn(tutor, session, "tengo hambre")

    assert asked and off_script and session.said == []
    assert "No hints: this is a measurement." in first["instructions"][-1]
    assert first["instructions"][-1].endswith(response_language("es"))
    # The rules of one moment do not outlive it.
    assert "No hints" not in second["instructions"][-1]


async def test_lines_that_may_repeat_the_student_are_judged_together_before_any_is_said():
    lines = (
        Line("Dijiste cinco sextos.", echoes=True),
        Line("Mira el círculo. ¿Qué fracción está pintada?"),
        Line("Me contaste que sumaste los de arriba.", echoes=True),
    )
    engine = ScriptedEngine([Line("hola")], Reply(lines=lines), Reply(lines=lines))
    gates = ScriptedGates(ALLOW, ALLOW, ALLOW, Decision(Action.REDIRECT, "redirect"))
    tutor, session = Tutor(language="es", gates=gates, engine=engine), Session()

    await scripted_turn(tutor, session)
    await scripted_turn(tutor, session)

    # One judgement per answer, over the lines that echo and nothing else.
    assert (
        gates.spoken_texts == ["Dijiste cinco sextos. Me contaste que sumaste los de arriba."] * 2
    )
    assert [text for text, _, _ in session.said] == [
        *[line.say for line in lines],
        # Refused: the fixed line stands in for them and the engine's own is still said.
        REPLIES["redirect"]["es"],
        "Mira el círculo. ¿Qué fracción está pintada?",
    ]


async def test_the_engines_own_lines_are_not_sent_to_be_judged():
    engine = ScriptedEngine([Line("hola")], Reply(lines=(Line("Pregunta 1 de 5."),)))
    gates = ScriptedGates(ALLOW)
    tutor, session = Tutor(language="es", gates=gates, engine=engine), Session()

    await scripted_turn(tutor, session)

    assert gates.spoken_texts == [] and session.said == [("Pregunta 1 de 5.", True, True)]


async def test_when_the_engine_closes_the_session_it_ends_after_its_last_lines():
    engine = ScriptedEngine([Line("hola")], Reply(lines=(Line("Hasta la próxima."),), closed=True))
    tutor, session = Tutor(language="es", gates=ScriptedGates(ALLOW), engine=engine), Session()
    session.shutdown = lambda: session.said.append("closed")

    to_the_model, _ = await scripted_turn(tutor, session)

    assert not to_the_model
    assert session.said == [("Hasta la próxima.", True, True), "closed"]


async def test_lines_for_an_answer_typed_on_the_page_stop_the_tutor_and_are_said():
    tutor, session = Tutor(language="es", gates=ScriptedGates(), engine=ScriptedEngine()), Session()

    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
        await tutor.scripted_lines(Reply(lines=(Line("¡Correcto!"), Line("Pregunta 2 de 5."))))

    assert session.interrupts == 1
    assert [text for text, _, _ in session.said] == ["¡Correcto!", "Pregunta 2 de 5."]


async def test_an_answer_written_on_the_page_cuts_the_lines_still_to_come_of_the_last_one():
    shown = []

    async def show(visual):
        shown.append(visual)

    circle = {"kind": "fraction_circle", "fractions": [{"numerator": 3, "denominator": 8}]}
    question_1 = (
        Line("Aquí no hay pistas."),
        Line("Pregunta 1 de 5."),
        Line("Mira el círculo.", show=circle),
    )
    question_2 = Reply(lines=(Line("¡Gracias! Lo anoto."), Line("Pregunta 2 de 5.")))
    tutor = Tutor(language="es", gates=ScriptedGates(), engine=ScriptedEngine(), show=show)
    session, speaking = Session(), asyncio.Event()

    def say(text, *, add_to_chat_ctx, allow_interruptions):
        session.said.append((text, add_to_chat_ctx, allow_interruptions))

        async def played():
            # The first line is still being said when the page's answer arrives.
            if text == "Aquí no hay pistas.":
                speaking.set()
                await asyncio.sleep(0.05)
            return SimpleNamespace(interrupted=False)

        return played()

    session.say = say
    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
        first = asyncio.create_task(tutor._say(question_1))
        await speaking.wait()
        await tutor.scripted_lines(question_2)
        await first

    assert [text for text, _, _ in session.said] == [
        "Aquí no hay pistas.",
        "¡Gracias! Lo anoto.",
        "Pregunta 2 de 5.",
    ]
    # The circle of question 1 is not drawn next to the card of question 2.
    assert shown == []


async def test_a_turn_the_gates_stop_never_reaches_the_engine():
    engine = ScriptedEngine([Line("hola")], Reply(lines=(Line("x"),)))
    tutor, session = Tutor(language="es", gates=ScriptedGates(HAZARD), engine=engine), Session()

    to_the_model, _ = await scripted_turn(tutor, session)

    assert not to_the_model and engine.heard == []


async def test_without_an_engine_the_turn_is_the_models_as_before():
    tutor, session = Tutor(language="es", gates=ScriptedGates(ALLOW)), Session()

    to_the_model, updates = await scripted_turn(tutor, session)

    assert to_the_model and updates == {"instructions": [], "context": []}


def conversation(*turns):
    chat = llm.ChatContext.empty()
    for role, text in turns:
        chat.add_message(role=role, content=text)
    return chat


@pytest.mark.parametrize(
    "turns",
    [
        [("assistant", "¿Cuánto te salió?"), ("user", "Mira, aquí está mi cuaderno.")],
        [("assistant", "Muéstrame cómo lo hiciste."), ("user", "Ya.")],
        [("assistant", "Acércalo un poco a la cámara."), ("user", "¿Así?")],
        [("assistant", "How did it go?"), ("user", "Look, I wrote it here.")],
        [("user", "Te muestro mi tarea.")],
    ],
)
def test_the_camera_is_looked_at_when_work_is_shown_or_asked_for(turns):
    assert shows_something(conversation(*turns))


@pytest.mark.parametrize(
    "turns",
    [
        [("assistant", "¿Cómo te fue hoy?"), ("user", "Bien, jugué fútbol.")],
        [("assistant", "¿Cuántas canicas sombreadas hay?"), ("user", "Creo que tres.")],
        [("user", "Mira mi cuaderno."), ("assistant", "Muy bien."), ("user", "¿Y ahora?")],
        # A tutor names the homework and says "look at the screen" all the
        # time: neither is asking to see the student's work.
        [("assistant", "¡Hola! ¿Qué tarea traes hoy?"), ("user", "Dibújame un hexágono.")],
        [("assistant", "Mira la pantalla: ¿cuántos lados tiene?"), ("user", "Seis.")],
        [("assistant", "Look at the picture on the screen."), ("user", "It has six sides.")],
        # Naming the homework is not showing it.
        [("user", "Tengo tarea de fracciones en mi cuaderno.")],
        [("user", "Enséñame a sumar fracciones.")],
        [],
    ],
)
def test_the_camera_is_left_alone_in_ordinary_talk(turns):
    assert not shows_something(conversation(*turns))


class Lens:
    """A camera that has, or has not, something new to show."""

    def __init__(self, fresh=None, latest=None):
        self._fresh, self._latest = fresh, latest
        self.waited = []

    async def fresh(self, timeout):
        self.waited.append(timeout)
        return self._fresh

    def latest(self):
        return self._latest


async def test_the_button_that_shows_work_gets_a_look_and_an_answer_at_once():
    lens, session = Lens(fresh="the page of the notebook", latest="a moment later"), Session()
    tutor = Tutor(language="es", gates=ScriptedGates(), camera=lens)

    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
        assert await tutor.show_work() is True
    assert lens.waited == [FRESH_FRAME_SECONDS]

    # Whatever the tutor was saying stops, and the student's turn is the button's.
    assert session.interrupts == 1
    assert session.replies_to == ["Mira mi trabajo."]
    # The image is the one taken at the press, once.
    turn = conversation(("user", "Mira mi trabajo."))
    assert tutor._frame_for(turn) == "the page of the notebook"
    assert tutor._frame_for(conversation(("user", "¿Está bien?"))) is None


async def test_work_shown_while_a_line_that_cannot_be_cut_is_said_waits_for_it_to_end():
    lens, session = Lens(fresh="the page of the notebook"), Session()
    session.current_speech = Speaking(session)
    tutor = Tutor(language="es", gates=ScriptedGates(), camera=lens)

    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
        assert await tutor.show_work() is True

    assert session.order == ["played out", "interrupt", "reply"]
    assert session.replies_to == ["Mira mi trabajo."]


async def test_work_shown_during_a_long_line_that_cannot_be_cut_is_answered_in_time_after_it():
    # The page stops waiting for the button's answer after a while. A line that cannot be cut
    # and lasts longer than the tutor waits is not cut: the reply is queued behind it.
    lens, session = Lens(fresh="the page of the notebook"), Session()
    session.current_speech = Endless(session)
    tutor = Tutor(language="es", gates=ScriptedGates(), camera=lens)

    with (
        patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session),
        patch("aule_agent.tutor.UNCUT_WAIT_SECONDS", 0.01),
    ):
        assert await asyncio.wait_for(tutor.show_work(), 1) is True

    assert session.order == ["reply"]
    assert session.replies_to == ["Mira mi trabajo."]


def test_the_button_waits_for_the_camera_and_such_lines_for_less_than_the_page_waits_for_it():
    # livekit-client's performRpc gives up after 15 s and keeps 7 s of them for the transport.
    assert FRESH_FRAME_SECONDS + UNCUT_WAIT_SECONDS < 15 - 7


async def test_a_camera_with_nothing_to_show_gets_no_answer():
    session = Session()
    tutor = Tutor(language="es", gates=ScriptedGates(), camera=Lens(fresh=None))

    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
        assert await tutor.show_work() is False
        assert await Tutor(language="es", gates=ScriptedGates()).show_work() is False

    assert not hasattr(session, "replies_to") and not hasattr(session, "interrupts")


async def test_a_drawing_is_never_left_without_a_word():
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW, ALLOW))
    tutor._drew = True

    async def nothing(*_):
        return
        yield

    with patch.object(Agent.default, "llm_node", side_effect=lambda *a: nothing()):
        said = [chunk async for chunk in tutor.llm_node(llm.ChatContext.empty(), [], None)]

    assert said == [REPLIES["look_at_screen"]["es"]]


async def test_an_empty_step_with_no_drawing_stays_empty():
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW))

    async def nothing(*_):
        return
        yield

    with patch.object(Agent.default, "llm_node", side_effect=lambda *a: nothing()):
        said = [chunk async for chunk in tutor.llm_node(llm.ChatContext.empty(), [], None)]

    assert said == []


async def test_a_drill_measures_the_spoken_try_and_draws_its_tune():
    import numpy as np

    shown = []

    async def screen(visual):
        shown.append(visual)

    tutor = Tutor(language="es", gates=ScriptedGates(), show=screen)
    assert "check_phrase" in await tool(tutor, "pose_phrase")({"sentence": "Is it raining?"})
    # The student's try, as speech to text receives it: a voice going up.
    rate = 16_000
    hz = np.linspace(200, 320, rate)
    tone = sum(np.sin(k * 2 * np.pi * np.cumsum(hz) / rate) / k for k in range(1, 5))
    samples = (0.3 * tone / np.max(np.abs(tone)) * 32767).astype(np.int16)
    for start in range(0, len(samples), 160):
        tutor._drill.hear(samples[start : start + 160], rate)
    tutor._drill.took()

    said = await tool(tutor, "check_phrase")({})
    assert said.startswith("Their voice went up at the end")
    assert [visual["kind"] for visual in shown] == ["contour"] and shown[0]["expected"] == "rising"
    assert not tutor._drill.open


async def test_comparing_numbers_does_not_replace_the_registered_exercise() -> None:
    checker = ScriptedChecker(posed="Ask it.", judged="Correct.")
    tutor = Tutor(language="es", gates=ScriptedGates(), checker=checker)
    await tool(tutor, "pose_exercise")({"expression": "1/14 + 1/15"})
    compared = json.loads(await tool(tutor, "compare_numbers")({"left": "2/29", "right": "1/15"}))
    assert compared["relation"] == "greater_than"
    await tool(tutor, "check_answer")({"said": "29/210"})
    assert checker.calls == [("pose", "1/14 + 1/15", None, None), ("answer", "29/210")]


async def test_an_unavailable_gate_does_not_release_any_paragraph() -> None:
    gates = ScriptedGates(Decision(Action.UNAVAILABLE, "unavailable"))
    text = "Una explicación completa.\n\nUna pregunta para el estudiante."
    released = [c async for c in checked(stream(text), gates, "es")]
    assert gates.spoken_texts == [text]
    assert released == [reply("unavailable", "es")]


async def test_each_stage_of_a_turn_is_timed_for_the_turn_it_belongs_to():
    timing = Timing()
    timing.released()
    gates = ScriptedGates(ALLOW, ALLOW)
    tutor = Tutor(language="es", gates=gates, timing=timing)

    async def model(*_):
        yield llm.ChatChunk(id="1", delta=llm.ChoiceDelta(role="assistant", content="Muy bien. "))
        yield llm.ChatChunk(id="1", delta=llm.ChoiceDelta(role="assistant", content="Sigue."))

    async def voice(agent, text, settings):
        async for _ in text:
            yield rtc.AudioFrame(bytes(4), 24_000, 1, 2)

    async def words():
        yield "Muy bien. Sigue."

    assert await hear(tutor, Session())
    with patch.object(Agent.default, "llm_node", side_effect=lambda *a: model()):
        said = [chunk async for chunk in tutor.llm_node(llm.ChatContext.empty(), [], None)]
    with patch.object(Agent.default, "tts_node", side_effect=voice):
        frames = [frame async for frame in tutor.tts_node(words(), None)]
    timing.agent_state("speaking")

    assert [getattr(chunk, "id", chunk) for chunk in said] == ["1", "1"] and len(frames) == 1
    summary = timing.summary()
    stages = ("gates_in", "llm_ttft", "first_sentence", "gate_out", "tts_ttfb", "first_audio")
    assert all(f"{stage}_ms_p50" in summary for stage in stages)


def speech(kind, text=""):
    alternatives = [stt.SpeechData(language="es", text=text)] if text else []
    return stt.SpeechEvent(type=kind, alternatives=alternatives)


async def heard_through(tutor, *events):
    async def hearing(*_):
        for event in events:
            yield event

    async def silence():
        return
        yield

    with patch.object(Agent.default, "stt_node", side_effect=hearing):
        return [event async for event in tutor.stt_node(silence(), None)]


@pytest.mark.parametrize(
    ("events", "in_flight"),
    [
        ([], False),
        ([speech(stt.SpeechEventType.START_OF_SPEECH)], True),
        ([speech(stt.SpeechEventType.INTERIM_TRANSCRIPT, "doce")], True),
        ([speech(stt.SpeechEventType.INTERIM_TRANSCRIPT)], False),
        (
            [
                speech(stt.SpeechEventType.START_OF_SPEECH),
                speech(stt.SpeechEventType.INTERIM_TRANSCRIPT, "doce"),
                speech(stt.SpeechEventType.FINAL_TRANSCRIPT, "doce"),
                speech(stt.SpeechEventType.END_OF_SPEECH),
            ],
            False,
        ),
        # An empty final settles nothing: LiveKit keeps the interim.
        (
            [
                speech(stt.SpeechEventType.INTERIM_TRANSCRIPT, "doce"),
                speech(stt.SpeechEventType.FINAL_TRANSCRIPT),
            ],
            True,
        ),
        # The student went on after the final.
        (
            [
                speech(stt.SpeechEventType.FINAL_TRANSCRIPT, "doce"),
                speech(stt.SpeechEventType.START_OF_SPEECH),
            ],
            True,
        ),
    ],
)
async def test_the_tutor_knows_whether_a_final_transcript_may_still_come(events, in_flight):
    tutor = Tutor(language="es", gates=ScriptedGates())

    passed = await heard_through(tutor, *events)

    assert passed == events
    assert tutor.words_in_flight is in_flight


async def test_a_new_press_forgets_what_was_heard_before():
    tutor = Tutor(language="es", gates=ScriptedGates())
    await heard_through(tutor, speech(stt.SpeechEventType.INTERIM_TRANSCRIPT, "doce"))

    tutor.hold_started()

    assert tutor.words_in_flight is False
