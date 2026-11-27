"""The model's own questions while a question of the engine's is open
(``asking``): which sentences ask, what is said of a reply that has them, and
which question of the engine's follows it."""

import asyncio
from unittest.mock import patch

import pytest
from livekit.agents import Agent, llm

from aule_agent import asking
from aule_agent.moderation import Action, Decision
from aule_agent.script import Line, Reply
from aule_agent.tutor import Tutor

ALLOW = Decision(Action.ALLOW)

# Replies the model gave by voice on 2026-11-27 while the engine waited at its
# own «¿Seguimos?», and what is left of each.
ASKED = [
    (
        "¡Exacto, Gonzalo! Los pedazos siguen siendo quintos, por eso el denominador se queda "
        "igual. Lo que cambia es el número de pedazos. Ahora te toca a ti: ¿cuánto es 1/4 + 2/4?",
        "¡Exacto, Gonzalo! Los pedazos siguen siendo quintos, por eso el denominador se queda "
        "igual. Lo que cambia es el número de pedazos.",
    ),
    (
        "Muy bien razonado, Gonzalo: juntaste los pedazos de cuarto y el denominador se quedó "
        "igual. Ahora vamos a restar. Si tienes 3/4 y quitas 1/4, ¿qué crees que pasa con los "
        "pedazos de cuarto?",
        "Muy bien razonado, Gonzalo: juntaste los pedazos de cuarto y el denominador se quedó "
        "igual.",
    ),
    (
        "Gonzalo, explícame cómo llegaste a tres octavos: ¿qué hiciste con los números de "
        "arriba y qué pasó con el de abajo?",
        "",
    ),
    (
        "Gonzalo, lo que acabas de decir tiene un detalle: ¿cuánto vale un entero en cuartos? "
        "Piénsalo con el tamaño del pedazo que mencionaste.",
        "Piénsalo con el tamaño del pedazo que mencionaste.",
    ),
    (
        "Estás comparando bien las partes. Cuéntame tu razonamiento.",
        "Estás comparando bien las partes.",
    ),
    (
        "Así es, dos cuartos. Ahora vamos a practicar con un número nuevo para que lo pruebes "
        "tú. Mira este ejercicio: 4/9 + 2/9.",
        "Así es, dos cuartos.",
    ),
    ("Good thinking. Now it's your turn: how much is 1/4 + 2/4?", "Good thinking."),
    ("You counted the parts. Tell me how you got five.", "You counted the parts."),
]

# Answers that ask nothing of the student.
ANSWERS = [
    "¡Muy bien, Gonzalo! Cuatro cuartos forman un entero, y te sobran tres.",
    "El signo mayor es > y significa que la fracción de la izquierda es más grande.",
    "Claro. Con denominador 6, 1/2 es 3/6 y 2/3 es 4/6. Como 4 es más que 3, 2/3 es mayor.",
    "Piensa en las tablas del 4.",
    "That is right: the bottom number stays the same.",
]


@pytest.mark.parametrize(("written", "left"), ASKED)
def test_what_asks_the_student_is_left_out_and_the_answer_is_kept(written, left):
    assert asking.without(written) == left


@pytest.mark.parametrize("written", ANSWERS)
def test_an_answer_that_asks_nothing_is_not_touched(written):
    assert asking.without(written) is written


@pytest.mark.parametrize(
    ("line", "open_question"),
    [
        ("¿Seguimos?", "¿Seguimos?"),
        (
            "Los denominadores no se suman: al juntar, los pedazos no cambian de tamaño. "
            "¿Seguimos?",
            "¿Seguimos?",
        ),
        (
            "Ejercicio 5. Tienes 20 canicas y 15 son azules. ¿Qué fracción de tus canicas son "
            "azules? Dila simplificada.",
            "¿Qué fracción de tus canicas son azules? Dila simplificada.",
        ),
        (
            "Paso 1: el denominador pasó de 4 a 20. ¿Por qué número se multiplicó? (4 × ? = 20)",
            "¿Por qué número se multiplicó? (4 × ? = 20)",
        ),
        ("Step 1: the bar has five parts. How many are painted?", "How many are painted?"),
        ("¡Completaste la Etapa 2! Ya sabes comparar fracciones.", None),
        ("Te explico qué es ese signo:", None),
    ],
)
def test_the_question_a_line_of_the_engines_leaves_open(line, open_question):
    assert asking.question(line) == open_question


# --- the reply on its way to the voice ---------------------------------------------


class Gates:
    """Stands in for the gates: lets everything through and keeps what it read."""

    checks_spoken = True

    def __init__(self) -> None:
        self.spoken_texts: list[str] = []

    async def spoken(self, text: str) -> Decision:
        self.spoken_texts.append(text)
        return ALLOW


class Engine:
    """Stands in for the session engine: it is there, and says nothing by itself."""

    def opening(self) -> Reply:
        return Reply()

    async def said(self, text: str) -> Reply | None:
        return None


RULES = "Answer what the student asked."


def lines(*said: str) -> tuple[Line, ...]:
    return tuple(Line(line) for line in said)


async def reply(tutor: Tutor, *words: str) -> str:
    """The model's reply as it reaches the voice."""

    async def model(*_):
        for text in words:
            yield llm.ChatChunk(id="r", delta=llm.ChoiceDelta(role="assistant", content=text))

    with patch.object(Agent.default, "llm_node", side_effect=lambda *a: model()):
        chunks = [chunk async for chunk in tutor.llm_node(llm.ChatContext.empty(), [], None)]
    await asyncio.gather(*list(tutor._watches))
    return "".join(
        chunk if isinstance(chunk, str) else (chunk.delta.content or "") for chunk in chunks
    )


async def test_while_the_engine_waits_the_models_question_gives_way_to_the_engines(caplog):
    caplog.set_level("INFO", logger="aule.agent.tutor")
    gates = Gates()
    tutor = Tutor(language="es", gates=gates, engine=Engine())
    tutor._asked_by_the_engine(Reply(lines=lines("Para sumar, juntas los pedazos.", "¿Seguimos?")))

    said = await reply(
        tutor,
        "¡Exacto, Gonzalo! Siguen siendo quintos. ",
        "Ahora te toca a ti: ¿cuánto es 1/4 + 2/4?",
    )

    assert said == "¡Exacto, Gonzalo! Siguen siendo quintos. ¿Seguimos?"
    # The gate reads what is said, the engine's question with it.
    assert gates.spoken_texts == [said]
    # Counts only: what was left out is never logged.
    assert "questions of its own left out of a reply" in caplog.text
    assert "1/4" not in caplog.text and "te toca" not in caplog.text


async def test_an_answer_with_no_question_still_ends_with_the_engines():
    tutor = Tutor(language="es", gates=Gates(), engine=Engine())
    tutor._asked_by_the_engine(Reply(lines=lines("Paso 1: ¿los denominadores son iguales?")))

    said = await reply(tutor, "El denominador es el número de abajo.")

    assert said == "El denominador es el número de abajo. ¿los denominadores son iguales?"


async def test_a_reply_that_only_asked_says_the_engines_question():
    tutor = Tutor(language="es", gates=Gates(), engine=Engine())
    tutor._asked_by_the_engine(Reply(lines=lines("Ahora tú: 5/8 - 2/8. ¿Cuánto te queda?")))

    assert (
        await reply(tutor, "Gonzalo, explícame cómo llegaste a tres octavos.")
        == "¿Cuánto te queda?"
    )


async def test_the_engines_question_is_not_said_twice():
    tutor = Tutor(language="es", gates=Gates(), engine=Engine())
    tutor._asked_by_the_engine(Reply(lines=lines("¿Seguimos?")))

    assert await reply(tutor, "Sí, son quintos. ", "¿Seguimos?") == "Sí, son quintos. ¿Seguimos?"


async def test_the_question_stays_open_when_the_engine_hands_the_turn_to_the_model():
    tutor = Tutor(language="es", gates=Gates(), engine=Engine())
    tutor._asked_by_the_engine(Reply(lines=lines("¿Qué signo va: 4/7 __ 3/5? Elige <, > o =.")))
    # The student asked what a word means: a lead-in with no question, and the model's turn.
    tutor._asked_by_the_engine(Reply(lines=lines("Te explico qué es ese signo:"), converse=RULES))

    said = await reply(
        tutor, "El signo mayor es >. ", "¿Cómo llevarías 4/7 y 3/5 a un mismo denominador?"
    )

    assert said == "El signo mayor es >. ¿Qué signo va: 4/7 __ 3/5? Elige <, > o =."


async def test_an_answer_of_the_engines_with_no_question_closes_the_one_before():
    tutor = Tutor(language="es", gates=Gates(), engine=Engine())
    tutor._asked_by_the_engine(Reply(lines=lines("¿Seguimos?")))
    tutor._asked_by_the_engine(Reply(lines=lines("¡Completaste la Etapa 2!")))

    # Nothing of the engine's is open: the model's question is its own to ask.
    assert (
        await reply(tutor, "¡Bien hecho! ", "¿Qué te gustó más?")
        == "¡Bien hecho! ¿Qué te gustó más?"
    )


async def test_without_an_engine_the_model_asks_as_it_likes():
    tutor = Tutor(language="es", gates=Gates())

    assert (
        await reply(tutor, "Mira la barra. ", "¿Cuántas partes hay?")
        == "Mira la barra. ¿Cuántas partes hay?"
    )
