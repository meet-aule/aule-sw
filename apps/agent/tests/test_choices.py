"""Answers the student can tap under the tutor's question (``choices``): the
contract, the model's tool, the gate on what the model offers, and when the
screen gets them, the session engine's included."""

import asyncio
import json
import logging
from types import SimpleNamespace
from unittest.mock import PropertyMock, patch

import pytest
from livekit.agents import Agent, llm

from aule_agent import choices
from aule_agent.events import contracts_dir
from aule_agent.moderation import Action, Decision
from aule_agent.replies import REPLIES
from aule_agent.script import Line, Reply, lines_from
from aule_agent.tutor import Tutor, checked

EXAMPLES = sorted((contracts_dir() / "choices" / "examples").glob("*.json"))
ALLOW = Decision(Action.ALLOW)
REDIRECT = Decision(Action.REDIRECT, "redirect")
YES_NO = {"options": ["Sí", "No"], "multiple": False}


class Gates:
    """Stands in for the gates: answers each check with the next decision."""

    checks_spoken = True

    def __init__(self, *decisions: Decision) -> None:
        self.decisions = list(decisions)
        self.heard_texts: list[str] = []
        self.spoken_texts: list[str] = []

    async def heard(self, context, message) -> Decision:
        self.heard_texts.append(message.text_content)
        return self.decisions.pop(0)

    async def spoken(self, text: str) -> Decision:
        self.spoken_texts.append(text)
        return self.decisions.pop(0)


class Screen:
    """The page: what it was offered, in order with what was said."""

    def __init__(self, order: list[tuple[str, object]] | None = None) -> None:
        self.order = order if order is not None else []

    @property
    def offered(self) -> list[object]:
        return [what for kind, what in self.order if kind == "offered"]

    async def __call__(self, offered: dict) -> None:
        self.order.append(("offered", offered))


class Speech:
    """The reply the model is writing, until it has been played or cut off."""

    def __init__(self) -> None:
        self.interrupted = False
        self._callbacks: list = []

    def add_done_callback(self, callback) -> None:
        self._callbacks.append(callback)

    def done(self, *, interrupted: bool = False) -> None:
        self.interrupted = interrupted
        for callback in self._callbacks:
            callback(self)


class Session:
    """The voice: what it says, in order with what goes on the screen."""

    def __init__(self, order: list[tuple[str, object]], *, cut: str | None = None) -> None:
        self.order, self.cut = order, cut

    def say(self, text, *, add_to_chat_ctx, allow_interruptions):
        self.order.append(("said", text))

        async def played():
            return SimpleNamespace(interrupted=text == self.cut)

        return played()


async def offer(tutor: Tutor, speech: Speech, arguments: object) -> str:
    tool = next(tool for tool in tutor.tools if tool.info.name == "offer_choices")
    return await tool(SimpleNamespace(speech_handle=speech), arguments)


async def reply(tutor: Tutor, *words: str) -> list:
    """The model's reply after its tool step, as it reaches the voice."""

    async def model(*_):
        for text in words:
            yield llm.ChatChunk(id="r", delta=llm.ChoiceDelta(role="assistant", content=text))

    with patch.object(Agent.default, "llm_node", side_effect=lambda *a: model()):
        return [chunk async for chunk in tutor.llm_node(llm.ChatContext.empty(), [], None)]


async def settled(tutor: Tutor) -> None:
    await asyncio.gather(*list(tutor._watches))


def names(tutor: Tutor) -> list[str]:
    return [tool.info.name for tool in tutor.tools]


# --- the contract and the tool ------------------------------------------------


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda path: path.stem)
def test_every_example_of_the_contract_can_be_offered(path):
    assert choices.problems(json.loads(path.read_text(encoding="utf-8"))) == []


@pytest.mark.parametrize(
    "offered",
    [
        {},
        {"options": []},
        {"options": ["a", "b", "c", "d", "e"]},
        {"options": ["Sí", "Sí"]},
        {"options": ["Sí", "   "]},
        {"options": ["x" * 41]},
        {"options": ["Sí", "No"], "multiple": "yes"},
        {"options": ["Sí", "No"], "html": "<b>Sí</b>"},
        "Sí o no",
        None,
    ],
)
def test_what_a_screen_cannot_offer_is_refused(offered):
    assert choices.problems(offered)


def test_the_tool_is_written_by_hand_and_never_wider_than_the_contract():
    tool = choices.TOOL
    parameters = tool["parameters"]
    assert tool["name"] == "offer_choices"
    assert parameters["required"] == ["options", "multiple"]
    # The model's API refuses these at the top of a tool's schema, and an enum on a nullable type.
    assert not any(key.startswith("$") for key in parameters)
    assert not {"allOf", "anyOf", "oneOf"} & set(parameters)
    assert "null" not in json.dumps(parameters)
    contract = choices.schema()["properties"]["options"]
    options = parameters["properties"]["options"]
    assert contract["minItems"] < options["minItems"] == 2
    assert options["maxItems"] == contract["maxItems"] == 4
    assert options["items"]["maxLength"] == contract["items"]["maxLength"]
    # Short, as show's is: it is paid on every turn.
    assert len(choices.DESCRIPTION) <= 300
    for words in ("2 to 4", "multiple", "aloud", "naming the options"):
        assert words in choices.DESCRIPTION, words


def test_the_models_options_are_trimmed_and_must_follow_the_contract():
    assert choices.from_tool({"options": [" Sí ", "No"], "multiple": False}) == YES_NO
    several = {"options": ["2/4", "3/6", "2/3", "4/8"], "multiple": True}
    assert choices.from_tool(several) == several
    assert choices.problems(choices.from_tool({**several, "extra": 1})) == []
    for wrong in [
        # One option is not a choice the model offers.
        {"options": ["Sí"], "multiple": False},
        {"options": ["a", "b", "c", "d", "e"], "multiple": False},
        {"options": ["Sí", " Sí"], "multiple": False},
        {"options": ["Sí", " "], "multiple": False},
        {"options": ["Sí", "x" * 41], "multiple": False},
        {"options": ["Sí", "No"]},
        {"options": ["Sí", "No"], "multiple": "no"},
        {"options": "Sí, No", "multiple": False},
        None,
    ]:
        with pytest.raises(ValueError):
            choices.from_tool(wrong)


def test_the_gate_reads_every_option():
    assert choices.text_of(YES_NO) == "Sí\nNo"


def test_the_tool_is_there_only_with_a_screen_that_takes_choices():
    async def screen(_):
        return None

    plain = Tutor(language="es", gates=Gates(), show=screen)
    offering = Tutor(language="es", gates=Gates(), show=screen, offer=screen)
    assert "offer_choices" not in names(plain)
    assert names(offering) == ["compare_numbers", "show", "offer_choices", *names(plain)[2:]]
    # No sentence of the prompt is added for it: the tool says what it is for.
    assert offering.instructions == plain.instructions


# --- what the model offers ------------------------------------------------------


async def test_the_models_options_go_under_its_question_once_it_was_approved_and_heard():
    gates, screen, speech = Gates(ALLOW, ALLOW), Screen(), Speech()
    tutor = Tutor(language="es", gates=gates, offer=screen)

    assert await offer(tutor, speech, {"options": ["Sí", "No"], "multiple": False}) == (
        choices.OFFERED
    )
    # The gate read the options first; nothing is on the screen before the question.
    assert gates.spoken_texts == ["Sí\nNo"]
    said = await reply(tutor, "¿Seguimos ", "con otra?")
    assert [chunk.delta.content for chunk in said] == ["¿Seguimos ", "con otra?"]
    assert gates.spoken_texts == ["Sí\nNo", "¿Seguimos con otra?"]
    await settled(tutor)
    assert screen.offered == []
    speech.done()
    await settled(tutor)
    assert screen.offered == [YES_NO]


async def test_several_may_be_marked_when_the_model_says_so():
    gates, screen, speech = Gates(ALLOW, ALLOW), Screen(), Speech()
    tutor = Tutor(language="es", gates=gates, offer=screen)
    several = {"options": ["2/4", "3/6", "2/3"], "multiple": True}

    await offer(tutor, speech, several)
    await reply(tutor, "¿Cuáles son iguales a un medio?")
    speech.done()
    await settled(tutor)

    assert screen.offered == [several]


@pytest.mark.parametrize(
    ("arguments", "decisions", "told"),
    [
        # Malformed: refused without asking the gate.
        ({"options": ["Sí"], "multiple": False}, [ALLOW], "Not offered: "),
        (
            {"options": ["algo feo", "otra cosa"], "multiple": False},
            [REDIRECT, ALLOW],
            "Not offered: those options cannot be put on the screen.",
        ),
    ],
)
async def test_options_the_contract_or_the_gate_refuse_never_reach_the_screen(
    arguments, decisions, told
):
    gates, screen, speech = Gates(*decisions), Screen(), Speech()
    tutor = Tutor(language="es", gates=gates, offer=screen)

    answer = await offer(tutor, speech, arguments)
    await reply(tutor, "¿Seguimos?")
    speech.done()
    await settled(tutor)

    assert answer.startswith(told)
    assert screen.offered == []
    assert gates.spoken_texts[-1] == "¿Seguimos?" and gates.decisions == []


async def test_options_never_go_under_a_question_the_gate_stopped_cut_off_or_never_asked():
    stopped, cut, wordless = Speech(), Speech(), Speech()
    screen = Screen()

    # The output gate replaces the question: its fixed line gets no options.
    tutor = Tutor(language="es", gates=Gates(ALLOW, REDIRECT), offer=screen)
    await offer(tutor, stopped, YES_NO)
    assert await reply(tutor, "algo indebido") == [REPLIES["redirect"]["es"]]
    stopped.done()
    # The student cut the question off: they are already answering it.
    tutor = Tutor(language="es", gates=Gates(ALLOW, ALLOW), offer=screen)
    await offer(tutor, cut, YES_NO)
    await reply(tutor, "¿Seguimos?")
    cut.done(interrupted=True)
    # The model asked nothing in words.
    tutor = Tutor(language="es", gates=Gates(ALLOW, ALLOW), offer=screen)
    await offer(tutor, wordless, YES_NO)
    await reply(tutor)
    wordless.done()
    await settled(tutor)

    assert screen.offered == []


async def test_a_second_offer_for_the_same_question_replaces_the_first():
    gates, screen, speech = Gates(ALLOW, ALLOW, ALLOW), Screen(), Speech()
    tutor = Tutor(language="es", gates=gates, offer=screen)
    fractions = {"options": ["1/2", "2/4"], "multiple": False}

    await offer(tutor, speech, YES_NO)
    await offer(tutor, speech, fractions)
    await reply(tutor, "¿Cuál es mayor?")
    speech.done()
    await settled(tutor)

    assert screen.offered == [fractions]


async def test_a_screen_that_fails_costs_only_the_buttons(caplog):
    caplog.set_level(logging.INFO, logger="aule.agent.tutor")

    async def broken(_):
        raise ConnectionError("the room is gone")

    speech = Speech()
    tutor = Tutor(language="es", gates=Gates(ALLOW, ALLOW), offer=broken)
    await offer(tutor, speech, YES_NO)
    await reply(tutor, "¿Seguimos?")
    speech.done()
    await settled(tutor)

    assert "choices not sent" in caplog.text and "Sí" not in caplog.text


async def test_checked_tells_of_a_reply_only_once_nothing_stands_between_it_and_the_voice():
    told: list[str] = []

    async def stream(*chunks):
        for chunk in chunks:
            yield chunk

    tool_call = llm.ChatChunk(
        id="c",
        delta=llm.ChoiceDelta(
            role="assistant",
            tool_calls=[llm.FunctionToolCall(name="show", arguments="{}", call_id="c")],
        ),
    )
    open_gates = SimpleNamespace(checks_spoken=False)
    for gates, step in [
        (Gates(ALLOW), stream("¿Seguimos?")),
        (Gates(REDIRECT), stream("algo indebido")),
        (Gates(), stream("lo registro", tool_call)),
        (open_gates, stream("Sin gate.")),
    ]:
        [chunk async for chunk in checked(step, gates, "es", approved=told.append)]

    assert told == ["¿Seguimos?", "Sin gate."]


# --- what the session engine offers ------------------------------------------------


def test_the_engines_choices_come_with_their_line_and_a_broken_one_is_left_out():
    lines = lines_from(
        [
            {"say": "¿Empezamos?", "show": None, "echoes": False, "choices": {"options": ["Sí"]}},
            {"say": "Elige una:", "echoes": False, "choices": {"options": []}},
            {"say": "Mira.", "echoes": False, "choices": "Sí"},
            {"say": "Pregunta 1 de 5.", "echoes": False},
        ]
    )

    assert [line.say for line in lines] == [
        "¿Empezamos?",
        "Elige una:",
        "Mira.",
        "Pregunta 1 de 5.",
    ]
    assert [line.choices for line in lines] == [{"options": ["Sí"]}, None, None, None]


async def say(tutor: Tutor, session: Session, lines: tuple[Line, ...]) -> None:
    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
        await tutor._say(lines)


async def test_the_engines_choices_go_up_once_their_line_has_been_heard():
    order: list[tuple[str, object]] = []
    tutor = Tutor(language="es", gates=Gates(), offer=Screen(order))
    yes = {"options": ["Sí"], "multiple": False}

    await say(
        tutor,
        Session(order),
        (Line("¡Hola, Liam!"), Line("Hoy vamos a trabajar en tu tarea. ¿Empezamos?", choices=yes)),
    )

    assert order == [
        ("said", "¡Hola, Liam!"),
        ("said", "Hoy vamos a trabajar en tu tarea. ¿Empezamos?"),
        ("offered", yes),
    ]


async def test_the_engines_choices_wait_for_no_gate_but_never_go_with_a_line_not_heard():
    activities = {"options": ["Saltos de estrella", "Respiración del globo"], "multiple": False}
    order: list[tuple[str, object]] = []
    gates = Gates(REDIRECT)
    tutor = Tutor(language="es", gates=gates, offer=Screen(order))

    # Cut off as it is said: nothing to answer yet.
    await say(tutor, Session(order, cut="Elige una:"), (Line("Elige una:", choices=activities),))
    # One that may repeat the student and that the gate stops: the fixed line takes its place.
    await say(
        tutor,
        Session(order),
        (Line("Dijiste que sí. Elige una:", choices=activities, echoes=True),),
    )

    assert order == [("said", "Elige una:"), ("said", REPLIES["redirect"]["es"])]
    # The engine's own words are not sent to be judged; only the line that echoes was.
    assert gates.spoken_texts == ["Dijiste que sí. Elige una:"]


# --- what the student taps ------------------------------------------------------------


class Engine:
    """Stands in for the session engine: what it heard, word for word."""

    def __init__(self) -> None:
        self.heard: list[str] = []

    def opening(self) -> tuple[Line, ...]:
        return ()

    async def said(self, text: str) -> Reply | None:
        self.heard.append(text)
        return Reply(lines=(Line("¡Saltos de estrella! 1. Ponte de pie."),))


async def test_a_tap_is_a_typed_turn_judged_by_the_input_gates_and_given_as_it_is():
    order: list[tuple[str, object]] = []
    engine, gates = Engine(), Gates(ALLOW, REDIRECT)
    tutor = Tutor(language="es", gates=gates, engine=engine, offer=Screen(order))
    session = Session(order)
    session.interrupt = lambda: asyncio.sleep(0)
    session.current_speech = None
    empty = llm.ChatContext.empty()

    async def kept(_context) -> None:
        return None

    async def tap(text: str) -> None:
        with (
            patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session),
            patch.object(Tutor, "chat_ctx", new_callable=PropertyMock, return_value=empty),
            patch.object(Tutor, "update_chat_ctx", side_effect=kept),
        ):
            await tutor.typed(text)

    await tap("Saltos de estrella")
    # Several marked are one turn, as the page joins them.
    await tap("1/2, 2/4")

    assert gates.heard_texts == ["Saltos de estrella", "1/2, 2/4"]
    # The second was stopped by the input gates: the engine never got it.
    assert engine.heard == ["Saltos de estrella"]
