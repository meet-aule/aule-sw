"""A child's answer checked in code once their turn has passed every input
gate, before the model is asked, and the model's own check_answer."""

import asyncio
import json
import logging
from unittest.mock import ANY, PropertyMock, patch

import pytest
from livekit.agents import Agent, AgentSession, ModelSettings, StopResponse, llm
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN
from livekit.agents.voice.generation import mark_instructions_cache_boundary
from test_tutor import (
    ALLOW,
    HAZARD,
    LateGates,
    Lens,
    Model,
    ScriptedChecker,
    ScriptedGates,
    Session,
    tool,
)

from aule_agent.moderation import Action, Decision
from aule_agent.physical_safety import PhysicalSafetyGuard
from aule_agent.replies import MEANWHILE, reply
from aule_agent.tutor import CHECKED_IN_CODE, UNCHECKED, OpenExercise, TurnCheck, Tutor

ORDER = OpenExercise(7, "25 + 3 * 2")
# Every way the gates stop a turn (as test_tutor's stopped turns).
STOPS = [
    Decision(Action.REDIRECT, "redirect"),
    Decision(Action.SUPPORT, "self_harm_support"),
    Decision(Action.SUPPORT, "child_support"),
    Decision(Action.UNAVAILABLE, "unavailable"),
    Decision(Action.UNAVAILABLE, "context_limit"),
    Decision(Action.REDIRECT, "clarify"),
    HAZARD,
]


@pytest.fixture(autouse=True)
def no_watch_for_a_missing_reply(monkeypatch):
    async def nothing(self, accepted_at):
        return None

    monkeypatch.setattr(Tutor, "_report_a_missing_reply", nothing)


async def spoken(tutor, session, text):
    """One spoken turn as LiveKit hands it over: its message is made before
    the hook. Returns the turn's context as the hook left it, None when the
    hook stopped the turn, and the message."""
    message = llm.ChatMessage(role="user", content=[text])
    turn_ctx = tutor.chat_ctx.copy()
    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
        try:
            await tutor.on_user_turn_completed(turn_ctx, message)
        except StopResponse:
            return None, message
    return turn_ctx, message


async def typed(tutor, session, text):
    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
        return await tutor.typed(text)


def calls_in(chat_ctx):
    return [item for item in chat_ctx.items if item.type != "message"]


async def test_a_spoken_answer_is_checked_after_the_gates_and_read_as_the_models_own_call():
    checker = ScriptedChecker(judged="Incorrect. Give one hint.", exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW), checker=checker)

    turn_ctx, message = await spoken(tutor, Session(), "Me salió 56, ¿está bien?")

    assert checker.calls == [("answer", "Me salió 56, ¿está bien?")]
    call, output = turn_ctx.items
    assert (call.type, call.name) == ("function_call", "check_answer")
    assert call.call_id.startswith(CHECKED_IN_CODE)
    assert json.loads(call.arguments) == {"said": "Me salió 56, ¿está bien?"}
    assert (output.type, output.call_id, output.output, output.is_error) == (
        "function_call_output",
        call.call_id,
        "Incorrect. Give one hint.",
        False,
    )
    # LiveKit then inserts the turn's message, made before the hook, into the
    # model's request and into the history: it goes before the check in both.
    request = turn_ctx.copy()
    request.insert(message)
    history = tutor.chat_ctx.copy()
    history.insert(message)
    for chat_ctx in (request, history):
        assert [item.id for item in chat_ctx.items] == [message.id, call.id, output.id]
    assert tutor.turn_check == TurnCheck("answer", 7, "Incorrect. Give one hint.", ("code",))


class Judged(ScriptedGates):
    """Keeps each message the gates judged."""

    def __init__(self, *decisions):
        super().__init__(*decisions)
        self.messages = []

    async def heard(self, context, message):
        self.messages.append(message)
        return await super().heard(context, message)


async def test_a_typed_answer_is_checked_after_the_gates_and_its_own_message_is_answered():
    gates, checker = Judged(ALLOW), ScriptedChecker(judged="Correct.", exercise=ORDER)
    tutor, session = Tutor(language="es", gates=gates, checker=checker), Session()

    assert await typed(tutor, session, "  Creo que es 31.  ") == "reply 1"

    assert checker.calls == [("answer", "Creo que es 31.")]
    # The reply is asked for with the message the gates judged, made before the
    # check, under an id of its own (see the test after this one).
    (message,) = session.inputs
    (judged,) = gates.messages
    assert (message.role, message.content, message.created_at) == (
        judged.role,
        judged.content,
        judged.created_at,
    )
    assert message.id != judged.id
    history = tutor.chat_ctx.copy()
    call, output = history.items
    history.insert(message)
    assert [item.id for item in history.items] == [message.id, call.id, output.id]
    assert session.order == ["interrupt", "reply"]


async def test_the_physical_safety_gate_reads_a_typed_turn_as_it_did_before_answers_were_checked():
    # The gate keeps the messages it judged and reads them with the
    # conversation's, one entry per id. A typed turn's reply was asked with its
    # text, so the conversation held another message with it, and the gate read
    # the line twice in the turns after. That is the input its evaluation
    # measured, and it stays so: changing it needs that evaluation again.
    gates, checker = Judged(ALLOW), ScriptedChecker(judged="Correct.", exercise=ORDER)
    tutor, session = Tutor(language="es", gates=gates, checker=checker), Session()
    await typed(tutor, session, "voy a sacar el cable del enchufe")
    (judged,), (written,) = gates.messages, session.inputs
    guard = PhysicalSafetyGuard("key")
    guard._request(llm.ChatContext(), judged)
    # The conversation as the session keeps it once the reply is said.
    conversation = llm.ChatContext([written])
    conversation.add_message(role="assistant", content=["Primero, pide ayuda a un adulto."])

    body = guard._request(conversation, llm.ChatMessage(role="user", content=["ya está"]))

    assert [entry["content"] for entry in json.loads(body)["state"]["history"]] == [
        "voy a sacar el cable del enchufe",
        "voy a sacar el cable del enchufe",
        "Primero, pide ayuda a un adulto.",
    ]


@pytest.mark.parametrize(
    ("language", "words", "sent"),
    [
        ("es", "No entiendo. Explícamelo de otra manera, con algo más fácil.", "no sé"),
        ("en", "I don't understand. Explain it another way.", "I don't know"),
    ],
)
async def test_a_request_for_help_reaches_the_checker_as_the_fixed_phrase(language, words, sent):
    checker = ScriptedChecker(judged="They need help.", exercise=ORDER)
    tutor = Tutor(language=language, gates=ScriptedGates(ALLOW), checker=checker)

    turn_ctx, _ = await spoken(tutor, Session(), words)

    assert checker.calls == [("answer", sent)]
    assert json.loads(turn_ctx.items[0].arguments) == {"said": sent}
    assert tutor.turn_check.kind == "help"


@pytest.mark.parametrize("checker", [None, ScriptedChecker(judged="Correct.")])
async def test_nothing_is_checked_while_no_exercise_is_open(checker):
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW, ALLOW), checker=checker)

    turn_ctx, _ = await spoken(tutor, Session(), "Me salió 31")
    assert await typed(tutor, Session(), "Me salió 31") == "reply 1"

    assert turn_ctx.items == [] and calls_in(tutor.chat_ctx) == []
    assert checker is None or checker.calls == []
    assert tutor.turn_check is None


@pytest.mark.parametrize(
    "words",
    [
        "¿primero multiplico 3 por 2?",
        "treinta y uno",
        "Solo dime la respuesta final, tengo prisa.",
        "A mí me salió 31",
    ],
)
async def test_what_code_leaves_to_the_model_is_checked_by_its_own_call_once(words):
    checker = ScriptedChecker(judged="Correct.", exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW), checker=checker)

    turn_ctx, _ = await spoken(tutor, Session(), words)

    assert turn_ctx.items == [] and checker.calls == []
    assert tutor.turn_check == TurnCheck("left", 7)
    assert await tool(tutor, "check_answer")({"said": "31"}) == "Correct."
    assert await tool(tutor, "check_answer")({"said": "31"}) == "Correct."
    assert checker.calls == [("answer", "31")]
    assert tutor.turn_check == TurnCheck("left", 7, "Correct.", ("model", "reused"))


async def test_the_models_own_check_of_a_turn_checked_in_code_is_answered_without_a_call():
    checker = ScriptedChecker(judged="Incorrect. Aim at the order.", exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW), checker=checker)
    await spoken(tutor, Session(), "Me salió 56")

    assert await tool(tutor, "check_answer")({"said": "56"}) == "Incorrect. Aim at the order."
    assert await tool(tutor, "check_answer")({"said": "cincuenta y seis"}) == (
        "Incorrect. Aim at the order."
    )

    assert checker.calls == [("answer", "Me salió 56")]
    assert tutor.turn_check.by == ("code", "reused", "reused")


async def test_an_answer_that_closed_its_exercise_is_not_checked_again_in_the_turn():
    checker = ScriptedChecker(judged="Correct.", exercise=ORDER, closes=True)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW), checker=checker)

    await spoken(tutor, Session(), "Es 31")
    assert checker.exercise is None

    assert await tool(tutor, "check_answer")({"said": "31"}) == "Correct."
    assert checker.calls == [("answer", "Es 31")]


@pytest.mark.parametrize("judged", [None, RuntimeError("down"), TimeoutError()])
async def test_a_check_that_fails_leaves_the_model_on_its_own_and_is_not_tried_again(judged):
    checker = ScriptedChecker(judged=judged, exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW), checker=checker)

    turn_ctx, _ = await spoken(tutor, Session(), "Me salió 31")

    _, output = turn_ctx.items
    assert output.output == UNCHECKED and not output.is_error
    # A call that timed out may still have counted: the model's own gets the same.
    assert await tool(tutor, "check_answer")({"said": "31"}) == UNCHECKED
    assert checker.calls == [("answer", "Me salió 31")]


async def test_a_check_that_breaks_leaves_the_turn_to_the_model(monkeypatch):
    def broken(*_):
        raise ValueError("a bug")

    monkeypatch.setattr("aule_agent.tutor.answers.to_check", broken)
    checker = ScriptedChecker(judged="Correct.", exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW), checker=checker)

    turn_ctx, _ = await spoken(tutor, Session(), "Me salió 31")

    assert turn_ctx is not None and turn_ctx.items == [] and checker.calls == []


async def test_an_exercise_posed_in_the_turn_is_checked_by_the_models_own_call_once():
    checker = ScriptedChecker(posed="Ask it.", judged="Correct.", exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW), checker=checker)
    await spoken(tutor, Session(), "Me salió 56")

    await tool(tutor, "pose_exercise")({"expression": "1/2 + 1/3"})
    assert await tool(tutor, "check_answer")({"said": "5/6"}) == "Correct."
    assert await tool(tutor, "check_answer")({"said": "5/6"}) == "Correct."

    assert checker.calls == [
        ("answer", "Me salió 56"),
        ("pose", "1/2 + 1/3", None, None),
        ("answer", "5/6"),
    ]


async def test_each_turn_is_checked_on_its_own():
    checker = ScriptedChecker(judged="Incorrect.", exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW, ALLOW), checker=checker)

    await spoken(tutor, Session(), "Me salió 56")
    await spoken(tutor, Session(), "treinta y uno")
    assert await tool(tutor, "check_answer")({"said": "31"}) == "Incorrect."

    assert checker.calls == [("answer", "Me salió 56"), ("answer", "31")]


async def test_work_shown_with_the_button_is_not_checked_in_code_and_the_model_checks_it_once():
    checker = ScriptedChecker(judged="Correct.", exercise=ORDER)
    tutor = Tutor(
        language="es", gates=ScriptedGates(ALLOW), checker=checker, camera=Lens(fresh="page")
    )
    await spoken(tutor, Session(), "Me salió 56")

    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=Session()):
        assert await tutor.show_work() is True
    # The button is a turn of its own, with no words of the child to check.
    assert tutor.turn_check is None
    assert await tool(tutor, "check_answer")({"said": "31"}) == "Correct."
    assert await tool(tutor, "check_answer")({"said": "31"}) == "Correct."

    assert checker.calls == [("answer", "Me salió 56"), ("answer", "31")]


# A turn that answers a fixed line, not the exercise.


@pytest.mark.parametrize("words", ["no sé", "Me salió 31"])
@pytest.mark.parametrize("decision", STOPS)
@pytest.mark.parametrize("path", ["spoken", "typed"])
async def test_the_turn_after_one_the_gates_stopped_is_left_to_the_model(decision, path, words):
    checker = ScriptedChecker(judged="Give the first hint.", exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(decision, ALLOW, ALLOW), checker=checker)
    session = Session()
    turn = spoken if path == "spoken" else typed

    assert await turn(tutor, session, "voy a meter un tenedor al enchufe") in (None, (None, ANY))
    await turn(tutor, session, words)

    # It answers the gate's line ("no sé" to "pide ayuda a un adulto"), not the
    # exercise: nothing reaches the checker, and the model reads the turn whole.
    assert checker.calls == [] and calls_in(tutor.chat_ctx) == []
    assert tutor.turn_check == TurnCheck("left", 7)
    # The turn after that one is read again.
    await turn(tutor, session, "no sé")
    assert checker.calls == [("answer", "no sé")]


@pytest.mark.parametrize(
    "key",
    ["unavailable", "redirect", "child_support", "adult_help", "clarify", "break_over"],
)
async def test_the_turn_after_a_fixed_line_is_left_to_the_model(key):
    checker = ScriptedChecker(judged="Give the first hint.", exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW, ALLOW), checker=checker)
    # As the conversation keeps it: a gate's line said in place of a reply, or
    # the clock's.
    context = tutor.chat_ctx.copy()
    context.add_message(role="assistant", content=[reply(key, "es")])
    await tutor.update_chat_ctx(context)

    turn_ctx, _ = await spoken(tutor, Session(), "no sé")

    assert calls_in(turn_ctx) == [] and checker.calls == []
    assert tutor.turn_check == TurnCheck("left", 7)


@pytest.mark.parametrize(
    "line",
    ["¿Qué operación harías primero?", reply(MEANWHILE[0], "es"), reply("look_at_screen", "es")],
)
async def test_the_turn_after_the_tutors_own_line_is_checked(line):
    checker = ScriptedChecker(judged="Give the first hint.", exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW), checker=checker)
    context = tutor.chat_ctx.copy()
    context.add_message(role="assistant", content=[line])
    await tutor.update_chat_ctx(context)

    await spoken(tutor, Session(), "no sé")

    assert checker.calls == [("answer", "no sé")]


# Turns that overlap: each is checked on its own, and no check is lost.


class Held(ScriptedChecker):
    """A checker whose answers wait for ``release``."""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.release = asyncio.Event()

    async def answer(self, said):
        await self.release.wait()
        return await super().answer(said)


async def settle():
    for _ in range(20):
        await asyncio.sleep(0)


async def test_a_message_typed_while_a_spoken_answer_is_checked_loses_no_check(caplog):
    checker = Held(judged="Incorrect. Give one hint.", exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW, ALLOW), checker=checker)
    message = llm.ChatMessage(role="user", content=["Me salió 56"])
    turn_ctx = tutor.chat_ctx.copy()
    session = Session()

    with (
        caplog.at_level(logging.INFO),
        patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session),
    ):
        spoken_turn = asyncio.create_task(tutor.on_user_turn_completed(turn_ctx, message))
        await settle()
        typed_turn = asyncio.create_task(tutor.typed("¿Por qué?"))
        await settle()
        checker.release.set()
        await spoken_turn
        assert await typed_turn == "reply 1"

    # The spoken answer was checked once, and its check reaches its own reply
    # and the history, though the typed turn began meanwhile.
    assert checker.calls == [("answer", "Me salió 56")]
    call, output = turn_ctx.items
    assert output.output == "Incorrect. Give one hint."
    assert [item.id for item in calls_in(tutor.chat_ctx)] == [call.id, output.id]
    assert "answer not checked" not in caplog.text
    # The typed turn, the one now, has its own reading.
    assert tutor.turn_check == TurnCheck("left", 7)


async def test_two_answers_typed_back_to_back_are_each_checked_once_and_both_kept(caplog):
    checker = Held(judged="Incorrect.", exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW, ALLOW), checker=checker)
    session = Session()

    with (
        caplog.at_level(logging.INFO),
        patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session),
    ):
        first = asyncio.create_task(tutor.typed("56"))
        await settle()
        second = asyncio.create_task(tutor.typed("no, 36"))
        await settle()
        checker.release.set()
        assert await asyncio.gather(first, second) == ["reply 1", "reply 2"]

    assert checker.calls == [("answer", "56"), ("answer", "no, 36")]
    saids = [json.loads(item.arguments)["said"] for item in calls_in(tutor.chat_ctx)[::2]]
    assert saids == ["56", "no, 36"]
    assert "answer not checked" not in caplog.text
    assert tutor.turn_check == TurnCheck("answer", 7, "Incorrect.", ("code",))


async def test_a_turn_begun_while_the_one_before_is_checked_never_takes_its_check():
    checker = Held(judged="Correct.", exercise=ORDER, closes=True)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW, ALLOW), checker=checker)
    session = Session()

    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
        first = asyncio.create_task(tutor.typed("31"))
        await settle()
        second = asyncio.create_task(tutor.typed("¿Y ahora qué hacemos?"))
        await settle()
        checker.release.set()
        await asyncio.gather(first, second)

    # The first answer closed the exercise. The second turn found none open: it
    # has no check, and the model's own check in it is not answered with the
    # first turn's.
    assert checker.exercise is None and tutor.turn_check is None
    checker.judged = "Not checked."
    assert await tool(tutor, "check_answer")({"said": "31"}) == "Not checked."
    assert checker.calls == [("answer", "31"), ("answer", "31")]


# An exercise the student brings, with their answer, before any is open.

BROUGHT = "Estoy haciendo 25 + 3 × 2. Me salió 56. ¿Está bien?"


async def test_an_answer_brought_with_its_exercise_is_checked_once_that_exercise_is_posed():
    checker = ScriptedChecker(posed="Ask it and wait.", judged="Incorrect. Give one hint.")
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW), checker=checker)
    turn_ctx, _ = await spoken(tutor, Session(), BROUGHT)
    assert turn_ctx.items == [] and checker.calls == []

    told = await tool(tutor, "pose_exercise")({"expression": "25 + 3 * 2"})

    assert told == "Ask it and wait. Their answer in this turn, checked: Incorrect. Give one hint."
    assert checker.calls == [
        ("pose", "25 + 3 * 2", None, None),
        ("answer", "Estoy haciendo . Me salió 56. ¿Está bien?"),
    ]
    assert tutor.turn_check == TurnCheck("answer", 1, "Incorrect. Give one hint.", ("pose",))
    # The model's own check of it gets the same answer, from no second call.
    assert await tool(tutor, "check_answer")({"said": "56"}) == "Incorrect. Give one hint."
    assert len(checker.calls) == 2


@pytest.mark.parametrize(
    "words",
    [
        # Not the exercise posed: an answer to something else, or no answer at all.
        "Me salió 56. ¿Está bien?",
        "Estoy haciendo 1/2 + 1/3. Me salió 2/5.",
        "Tengo 10 años",
        "Estoy haciendo 25 + 3 × 2. ¿Me ayudas a empezar con 3 por 2?",
    ],
)
async def test_a_pose_checks_nothing_the_turn_did_not_bring_with_that_exercise(words):
    checker = ScriptedChecker(posed="Ask it.", judged="Incorrect.")
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW), checker=checker)
    await spoken(tutor, Session(), words)

    assert await tool(tutor, "pose_exercise")({"expression": "25 + 3 * 2"}) == "Ask it."
    assert checker.calls == [("pose", "25 + 3 * 2", None, None)]


async def test_a_pose_checks_nothing_in_a_turn_already_checked():
    checker = ScriptedChecker(posed="Ask it.", judged="Incorrect.", exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW), checker=checker)
    # Left by code against the exercise open; the model checked something of it itself.
    await spoken(tutor, Session(), "Estoy haciendo 1/2 + 1/3. Me salió 2/5")
    await tool(tutor, "check_answer")({"said": "2/5"})

    assert await tool(tutor, "pose_exercise")({"expression": "1/2 + 1/3"}) == "Ask it."
    assert checker.calls == [("answer", "2/5"), ("pose", "1/2 + 1/3", None, None)]


async def test_a_pose_that_opened_nothing_new_checks_nothing():
    refused = ScriptedChecker(posed=None, judged="Incorrect.")
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW), checker=refused)
    await spoken(tutor, Session(), BROUGHT)
    assert await tool(tutor, "pose_exercise")({"expression": "25 + 3 * 2"}) == UNCHECKED
    assert refused.calls == [("pose", "25 + 3 * 2", None, None)]

    # The exercise was open, though the agent did not know it when the turn came:
    # posed again it is the same one, which this turn's words are not checked against.
    same = ScriptedChecker(posed="Same exercise.", judged="Incorrect.")
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW), checker=same)
    await spoken(tutor, Session(), BROUGHT)
    same.exercise = ORDER
    assert await tool(tutor, "pose_exercise")({"expression": "25 + 3 * 2"}) == "Same exercise."
    assert same.calls == [("pose", "25 + 3 * 2", None, None)]


async def test_a_pose_never_checks_the_words_of_an_earlier_turn():
    checker = ScriptedChecker(posed="Ask it.", judged="Incorrect.")
    tutor = Tutor(
        language="es", gates=ScriptedGates(ALLOW), checker=checker, camera=Lens(fresh="page")
    )
    await spoken(tutor, Session(), BROUGHT)
    # The button is a turn of its own: the words before it are not its words.
    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=Session()):
        assert await tutor.show_work() is True

    assert await tool(tutor, "pose_exercise")({"expression": "25 + 3 * 2"}) == "Ask it."
    assert checker.calls == [("pose", "25 + 3 * 2", None, None)]


async def test_a_pose_never_checks_the_words_of_a_turn_the_gates_stopped():
    checker = ScriptedChecker(posed="Ask it.", judged="Incorrect.")
    tutor = Tutor(language="es", gates=ScriptedGates(HAZARD), checker=checker)
    stopped, _ = await spoken(tutor, Session(), BROUGHT)
    assert stopped is None

    assert await tool(tutor, "pose_exercise")({"expression": "25 + 3 * 2"}) == "Ask it."
    assert checker.calls == [("pose", "25 + 3 * 2", None, None)]


async def test_a_pose_never_checks_the_words_of_a_turn_that_answers_a_gates_line():
    checker = ScriptedChecker(posed="Ask it.", judged="Incorrect.")
    tutor = Tutor(language="es", gates=ScriptedGates(HAZARD, ALLOW), checker=checker)
    stopped, _ = await spoken(tutor, Session(), "voy a meter un tenedor al enchufe")
    assert stopped is None
    # It passed its gates, but it follows the gate's line: it is not checked.
    await spoken(tutor, Session(), BROUGHT)

    assert await tool(tutor, "pose_exercise")({"expression": "25 + 3 * 2"}) == "Ask it."
    assert checker.calls == [("pose", "25 + 3 * 2", None, None)]


# The safety invariants.


async def test_a_check_adds_nothing_the_child_hears_or_reads():
    checker = ScriptedChecker(judged="Incorrect.", exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW, ALLOW), checker=checker)
    session = Session()

    await spoken(tutor, session, "Me salió 56")
    await typed(tutor, session, "No entiendo")

    assert session.said == []
    # Only checks join the history: no message, so nothing the transcript shows.
    checks = ["function_call", "function_call_output"] * 2
    assert [item.type for item in tutor.chat_ctx.items] == checks


async def test_the_checker_hears_a_turn_only_after_every_gate_let_it_through():
    class SlowGates(ScriptedGates):
        def __init__(self, *decisions):
            super().__init__(*decisions)
            self.decide = asyncio.Event()

        async def heard(self, context, message):
            self.order.append("judging")
            await self.decide.wait()
            self.decide.clear()
            return await super().heard(context, message)

    gates = SlowGates(ALLOW, ALLOW)
    checker = ScriptedChecker(judged="Incorrect.", exercise=ORDER, order=gates.order)
    tutor = Tutor(language="es", gates=gates, checker=checker)

    for turn in (spoken(tutor, Session(), "Me salió 56"), typed(tutor, Session(), "Es 31")):
        running = asyncio.create_task(turn)
        for _ in range(5):
            await asyncio.sleep(0)
        # While the gates judge the turn, the checker has heard nothing of it.
        assert gates.order[-1] == "judging"
        gates.decide.set()
        await running

    assert gates.order == ["judging", "heard", "answer", "judging", "heard", "answer"]


@pytest.mark.parametrize("decision", STOPS)
@pytest.mark.parametrize("path", ["spoken", "typed"])
async def test_a_turn_the_gates_stop_never_reaches_the_checker(decision, path):
    checker = ScriptedChecker(judged="Correct.", exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(decision), checker=checker)
    session = Session()

    if path == "spoken":
        stopped, _ = await spoken(tutor, session, "Me salió 31")
    else:
        stopped = await typed(tutor, session, "Me salió 31")

    assert stopped is None
    assert checker.calls == [] and tutor.turn_check is None
    assert calls_in(tutor.chat_ctx) == []
    # The turn got its fixed reply instead, as before.
    assert len(session.said) == 1


@pytest.mark.parametrize("path", ["spoken", "typed"])
async def test_a_goodbye_never_reaches_the_checker(path):
    checker = ScriptedChecker(judged="Correct.", exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW), checker=checker)
    tutor.on_goodbye = lambda: None

    if path == "spoken":
        stopped, _ = await spoken(tutor, Session(), "me salió 31, chau Aule")
    else:
        stopped = await typed(tutor, Session(), "me salió 31, chau Aule")

    assert stopped is None and checker.calls == [] and tutor.turn_check is None


async def test_a_check_logs_kinds_and_times_never_words(caplog):
    told = "Incorrect: aim at the order of operations."
    checker = ScriptedChecker(judged=told, exercise=ORDER)
    tutor = Tutor(language="es", gates=ScriptedGates(ALLOW, ALLOW, ALLOW), checker=checker)

    with caplog.at_level(logging.DEBUG):
        await spoken(tutor, Session(), "Me salió 56 porque mi hermana Lucía me lo explicó")
        await typed(tutor, Session(), "No entiendo nada, explícamelo con un dibujo")
        await tool(tutor, "check_answer")({"said": "Lucía dice 56"})
        checker.judged = RuntimeError("Me salió 31, dijo Lucía")
        await spoken(tutor, Session(), "Me salió 31, dijo Lucía")

    logged = "\n".join(f"{record.getMessage()} {vars(record)}" for record in caplog.records)
    assert "answer checked after the gates" in logged and "answer not checked" in logged
    assert [record.kind for record in caplog.records if hasattr(record, "kind")] == [
        "answer",
        "help",
        "answer",
    ]
    for private in ("Lucía", "hermana", "explicó", "entiendo", "dibujo", "aim at the order"):
        assert private not in logged


# With replies asked while the gates judge the turn (AULE_EARLY_REPLY): never
# while an exercise is open, and one asked before an exercise opened is
# dropped once its turn is checked, then asked again with the check in it.


class Asked(Model):
    """The model's requests, in the order things happened: "asked" when one
    is made."""

    def __init__(self, order, *texts, delay=0.0):
        super().__init__(*texts, delay=delay)
        self.order = order

    def __call__(self, agent, chat_ctx, tools, settings):
        self.order.append("asked")
        return super().__call__(agent, chat_ctx, tools, settings)


async def asked(tutor, session, model, text):
    """One spoken turn as LiveKit runs it: the hook, then, when the gates let
    the turn through, the reply asked with the turn's context as the hook
    left it and its message inserted. What was said; None when stopped."""
    turn_ctx = tutor.chat_ctx.copy()
    message = llm.ChatMessage(role="user", content=[text])
    session.agent_state = "speaking"
    with (
        patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session),
        patch.object(Agent.default, "llm_node", side_effect=model),
    ):
        try:
            await tutor.on_user_turn_completed(turn_ctx, message)
        except StopResponse:
            return None
        reply_ctx = turn_ctx.copy()
        reply_ctx.insert(message)
        mark_instructions_cache_boundary(reply_ctx)
        tools = llm.ToolContext(tutor.tools).flatten()
        return [chunk async for chunk in tutor.llm_node(reply_ctx, tools, ModelSettings())]


def checks_in(chat_ctx):
    return [(item.type, item.call_id) for item in calls_in(chat_ctx)]


@pytest.mark.parametrize("early", [False, True], ids=["early_off", "early_on"])
@pytest.mark.parametrize(
    ("words", "checked"),
    [("Me salió 56", True), ("No entiendo", True), ("¿primero multiplico 3 por 2?", False)],
)
async def test_while_an_exercise_is_open_the_model_is_asked_once_after_the_gates_and_the_check(
    early, words, checked
):
    gates = LateGates(ALLOW, ALLOW)
    model = Asked(gates.order)
    checker = ScriptedChecker(judged="Incorrect. Give one hint.", exercise=ORDER, order=gates.order)
    tutor = Tutor(language="es", gates=gates, checker=checker, early_reply=early)

    said = await asked(tutor, Session(), model, words)

    # Nothing was asked while the gates judged the turn: the one request
    # came after them and after the check, and holds it.
    assert said and len(model.requests) == 1
    assert gates.order == ["heard", *(["answer"] if checked else []), "asked"]
    ((request, _),) = model.requests
    assert checks_in(request) == checks_in(tutor.chat_ctx)
    assert len(checks_in(request)) == (2 if checked else 0)
    assert tutor.early_replies == {"used": 0, "dropped": 0}


@pytest.mark.parametrize("decision", STOPS)
async def test_while_an_exercise_is_open_a_stopped_turn_asks_the_model_nothing(decision):
    gates = LateGates(decision)
    model = Asked(gates.order)
    checker = ScriptedChecker(judged="Correct.", exercise=ORDER, order=gates.order)
    tutor = Tutor(language="es", gates=gates, checker=checker, early_reply=True)
    session = Session()

    assert await asked(tutor, session, model, "Me salió 31") is None

    assert gates.order == ["heard"] and model.requests == [] and checker.calls == []
    assert len(session.said) == 1 and tutor.early_replies == {"used": 0, "dropped": 0}


async def test_with_no_exercise_open_the_reply_is_asked_early_as_before_and_once_closed_again():
    gates = LateGates(ALLOW, ALLOW, ALLOW, ALLOW)
    model = Asked(gates.order)
    checker = ScriptedChecker(judged="Correct.", exercise=ORDER, closes=True, order=gates.order)
    tutor = Tutor(language="es", gates=gates, checker=checker, early_reply=True)

    # The answer closes the exercise; the next turn has none open.
    assert await asked(tutor, Session(), model, "Es 31")
    assert checker.exercise is None
    assert await asked(tutor, Session(), model, "¿Y ahora qué hacemos?")

    assert gates.order == ["heard", "answer", "asked", "asked", "heard"]
    assert tutor.early_replies == {"used": 1, "dropped": 0}
    assert checker.calls == [("answer", "Es 31")]


class Opening(LateGates):
    """Gates during whose judgement an exercise opens: a pose of the reply
    before, whose tools still ran when the student spoke again."""

    def __init__(self, checker, *decisions):
        super().__init__(*decisions)
        self.checker = checker

    async def heard(self, context, message):
        self.checker.exercise = ORDER
        return await super().heard(context, message)


async def test_a_reply_asked_before_an_exercise_opened_is_dropped_and_asked_again_with_the_check():
    checker = ScriptedChecker(judged="Incorrect. Give one hint.")
    gates = Opening(checker, ALLOW, ALLOW)
    checker.order = gates.order
    model = Asked(gates.order, delay=0.05)
    tutor = Tutor(language="es", gates=gates, checker=checker, early_reply=True)

    said = await asked(tutor, Session(), model, "Me salió 56")

    # Asked early, before anything was open; the turn was then checked after
    # its gates, and the early request was stopped unheard and asked again.
    assert gates.order == ["asked", "heard", "answer", "asked"]
    assert model.closed[0] == 0 and 0 not in model.finished
    (early, _), (again, _) = model.requests
    assert checks_in(early) == [] and len(checks_in(again)) == 2
    assert [chunk.id for chunk in said] == ["1", "1"]
    assert tutor.early_replies == {"used": 0, "dropped": 1}


# Through a real AgentSession, with a model that answers from a script.


class Script(llm.LLMStream):
    def __init__(self, model, *, step, **kwargs):
        super().__init__(model, **kwargs)
        self._step = step

    async def _run(self):
        self._event_ch.send_nowait(llm.ChatChunk(id="step", delta=self._step))


class ScriptedModel(llm.LLM):
    """The tutor's model, offline: each request gets the next step written."""

    def __init__(self, *steps):
        super().__init__()
        self.steps, self.requests = list(steps), []

    def chat(
        self,
        *,
        chat_ctx,
        tools=None,
        conn_options=DEFAULT_API_CONNECT_OPTIONS,
        parallel_tool_calls=NOT_GIVEN,
        tool_choice=NOT_GIVEN,
        extra_kwargs=NOT_GIVEN,
    ):
        self.requests.append(chat_ctx.copy())
        step = self.steps.pop(0)
        return Script(
            self, step=step, chat_ctx=chat_ctx, tools=tools or [], conn_options=conn_options
        )


def said(text):
    return llm.ChoiceDelta(role="assistant", content=text)


def calls(name, arguments):
    call = llm.FunctionToolCall(name=name, arguments=json.dumps(arguments), call_id="toolu_1")
    return llm.ChoiceDelta(role="assistant", tool_calls=[call])


def shown(chat_ctx):
    """What of a context the model is shown, without the instructions."""
    seen = []
    for item in chat_ctx.items:
        if item.type == "message" and item.role in ("user", "assistant"):
            seen.append((item.role, item.text_content))
        elif item.type == "function_call":
            seen.append(("call", item.name, json.loads(item.arguments)["said"]))
        elif item.type == "function_call_output":
            seen.append(("output", item.output))
    return seen


async def test_in_a_session_the_model_reads_the_turn_then_its_check_and_its_own_check_is_answered():
    checker = ScriptedChecker(judged="Incorrect. Give one hint.", exercise=ORDER)
    gates = ScriptedGates(*[ALLOW] * 4)
    tutor = Tutor(language="es", gates=gates, checker=checker)
    model = ScriptedModel(
        calls("check_answer", {"said": "56"}), said("¿Qué operación harías primero?")
    )
    reported = []

    async with AgentSession(llm=model, user_away_timeout=None) as session:
        session.on("conversation_item_added", lambda event: reported.append(event.item.type))
        await session.start(agent=tutor, session_host=False)
        handle = await tutor.typed("Me salió 56")
        await handle
        assert handle.exception() is None

        turn = [
            ("user", "Me salió 56"),
            ("call", "check_answer", "Me salió 56"),
            ("output", "Incorrect. Give one hint."),
        ]
        assert shown(model.requests[0]) == turn
        # The model checked again anyway (its step's fixed line said meanwhile): it
        # got the same answer, from no second call.
        assert shown(model.requests[1]) == [
            *turn,
            ("assistant", reply(MEANWHILE[0], "es")),
            ("call", "check_answer", "56"),
            ("output", "Incorrect. Give one hint."),
        ]
        assert checker.calls == [("answer", "Me salió 56")]
        assert shown(tutor.chat_ctx)[-1] == ("assistant", "¿Qué operación harías primero?")
        # The reply was judged whole by the output gate before it went out, and
        # nothing of the check ever went to the voice or the gate.
        assert gates.spoken_texts == ["¿Qué operación harías primero?"]
    # What the worker reports of the conversation are its messages: a check is never one.
    assert reported.count("message") >= 2
    assert "function_call" not in reported and "function_call_output" not in reported
