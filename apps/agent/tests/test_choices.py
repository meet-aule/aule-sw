"""Answers the student can tap under the tutor's question (``choices``): the
contract, and when the screen gets the session engine's."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import PropertyMock, patch

import pytest
from livekit.agents import llm

from aule_agent import choices
from aule_agent.events import contracts_dir
from aule_agent.moderation import Action, Decision
from aule_agent.replies import REPLIES
from aule_agent.script import Line, Reply, lines_from
from aule_agent.tutor import Tutor

EXAMPLES = sorted((contracts_dir() / "choices" / "examples").glob("*.json"))
ALLOW = Decision(Action.ALLOW)
REDIRECT = Decision(Action.REDIRECT, "redirect")


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


class Session:
    """The voice: what it says, in order with what goes on the screen."""

    def __init__(self, order: list[tuple[str, object]], *, cut: str | None = None) -> None:
        self.order, self.cut = order, cut

    def say(self, text, *, add_to_chat_ctx, allow_interruptions):
        self.order.append(("said", text))

        async def played():
            return SimpleNamespace(interrupted=text == self.cut)

        return played()


# --- the contract --------------------------------------------------------------


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
