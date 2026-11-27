"""The model's goodbyes in a session the engine runs (``closing``): which
sentences close a session, what is said of a reply that has them, and when the
goodbye is the model's to say."""

import asyncio
from types import SimpleNamespace
from unittest.mock import PropertyMock, patch

import pytest
from livekit.agents import Agent, llm

from aule_agent import closing
from aule_agent.moderation import Action, Decision
from aule_agent.replies import REPLIES
from aule_agent.script import Line, Reply, reply_from
from aule_agent.tutor import Tutor, checked

ALLOW = Decision(Action.ALLOW)

# Replies the model gave by voice on 2026-11-26 while the engine was still
# teaching, and what is said of each.
CLOSED = [
    (
        "¡Qué entusiasmo, Gonzalo! Por hoy cerramos aquí, pero me gustó tu esfuerzo. "
        "La próxima vez seguimos con más comparaciones y sumas de fracciones. ¡Hasta pronto!",
        "¡Qué entusiasmo, Gonzalo!",
    ),
    (
        "Así es, Gonzalo: 6 partes en total. Hoy trabajaste las fracciones equivalentes y la "
        "comparación, y lo hiciste muy bien. ¡Nos vemos pronto!",
        "Así es, Gonzalo: 6 partes en total.",
    ),
    (
        "Gonzalo, quizás hoy estás cansado y eso es normal. Descansa un momento, y cuando "
        "quieras seguimos. Por ahora, en 2/3, ¿qué número está arriba?",
        "Gonzalo, quizás hoy estás cansado y eso es normal. Por ahora, en 2/3, ¿qué número "
        "está arriba?",
    ),
    (
        "Me gusta tu entusiasmo, Gonzalo. Hoy ya cerramos la sesión, pero la próxima vez "
        "seguimos con otra pizza. ¡Hasta pronto!",
        "Me gusta tu entusiasmo, Gonzalo.",
    ),
    (
        "Eso es, Gonzalo: cuatro octavos y dos cuartos también muestran la misma cantidad. "
        "Seguimos con tu tarea cuando quieras.",
        "Eso es, Gonzalo: cuatro octavos y dos cuartos también muestran la misma cantidad.",
    ),
    (
        "Buen razonamiento, Gonzalo: si tienes tres de cuatro partes, te sobra una. Esa es la "
        "idea que seguiremos la próxima vez. ¡Hasta pronto!",
        "Buen razonamiento, Gonzalo: si tienes tres de cuatro partes, te sobra una.",
    ),
    ("Gonzalo, la sesión termina aquí por hoy. ¡Hasta pronto!", ""),
    ("Gonzalo, nos vemos en la próxima sesión. ¡Cuídate mucho!", ""),
    ("Gonzalo, te dejo descansar. ¡Hasta la próxima, nos vemos pronto!", ""),
    ("Great job! Next time we'll continue with sums. Bye!", "Great job!"),
    ("That's all for today. See you soon!", ""),
    ("You worked hard. Get some rest, and we carry on whenever you want.", "You worked hard."),
    # The day summed up while the engine was still teaching (the same day, after
    # the model was told not to say goodbye).
    (
        "Muy bien, Gonzalo. Llevaste las dos fracciones a décimos y comparaste las partes, "
        "que es justo lo que hay que hacer. Hoy trabajamos fracciones equivalentes, "
        "simplificación y comparación con distinto denominador. Sigue practicando así.",
        "Muy bien, Gonzalo. Llevaste las dos fracciones a décimos y comparaste las partes, "
        "que es justo lo que hay que hacer.",
    ),
    (
        "Ese razonamiento con doceavos es muy bien pensado, Gonzalo. Ya tienes lo principal "
        "de hoy: para comparar fracciones, las llevas a un mismo denominador.",
        "Ese razonamiento con doceavos es muy bien pensado, Gonzalo.",
    ),
    (
        "Cinco sextos es mayor, sí. Lo que trabajamos hoy fue comparar fracciones con "
        "distinto denominador usando un denominador común. ¡Muy buen trabajo hoy!",
        "Cinco sextos es mayor, sí.",
    ),
    (
        "Ya lo tienes, Gonzalo: cada parte es un cuarto. Esa es la idea que nos llevamos hoy.",
        "Ya lo tienes, Gonzalo: cada parte es un cuarto.",
    ),
    ("Hoy te costó bastante, y aun así lo lograste al contar con calma.", ""),
    ("Hoy lo trabajaste con la barra de chocolate y la pizza. ¡Muy bien hecho hoy!", ""),
    ("Hoy trabajamos cómo comparar fracciones; sigue practicando eso.", ""),
    ("¡Muy buen trabajo, sigue practicando!", ""),
    (
        "Right, five sixths. Today you worked on comparing fractions. Great job today!",
        "Right, five sixths.",
    ),
    ("What we did today was compare fractions. Keep practising!", ""),
]

# Sentences that share a word with a goodbye and are none.
GOES_ON = [
    "Exacto, el de abajo es el total de partes. Entonces, ¿qué número va abajo?",
    "La próxima vez cuenta primero el total. ¿Cuántas partes hay?",
    "Hoy vamos a trabajar fracciones. ¿Empezamos?",
    "¿Seguimos? Mira la barra: tiene 5 partes iguales y 3 están pintadas.",
    "Vemos que 2/4 y 1/2 pintan lo mismo. ¿Por qué crees que pasa?",
    "Para terminar esta etapa, dime con tus palabras qué es el denominador.",
    "Si estás cansado, dímelo. ¿Quieres descansar?",
    "I see you counted five. For today's exercise, look at the bar.",
    "Take the next step: which number goes below?",
    # A word of a summary, and none.
    "Para terminar, dime con tus palabras qué trabajamos hoy.",
    "¿Recuerdas lo que vimos hoy con la pizza?",
    "Gonzalo, la pizza de hoy ya la trabajamos: la partimos en cuatro y tomamos tres cuartos.",
    "Gonzalo, parece que hoy te cuesta seguir. ¿Quieres una pista?",
    "Cinco y seis sumados dan once, pero hoy no estamos sumando.",
    "¡Buen trabajo, Gonzalo! Ahora mira la barra.",
    "Buen trabajo explicándolo. ¿Cuál es mayor?",
    "Practicaste con calma y te salió. ¿Seguimos?",
    "Good job! Today's bar has five parts.",
]


@pytest.mark.parametrize(("written", "said"), CLOSED)
def test_what_closes_the_session_is_left_out_and_the_rest_is_kept(written, said):
    assert closing.without(written) == said


@pytest.mark.parametrize("written", GOES_ON)
def test_a_reply_that_goes_on_is_not_touched(written):
    assert closing.without(written) is written


def test_the_platform_says_when_the_engines_activity_is_over():
    rules = {"lines": [], "converse": "The session has ended."}
    assert reply_from({**rules, "over": True}) == Reply(
        converse="The session has ended.", over=True
    )
    assert reply_from(rules).over is False
    # Anything but a plain "yes" is "no", and alone it is nothing to say.
    assert reply_from({**rules, "over": "yes"}).over is False
    assert reply_from({"lines": [], "over": True}) is None


# --- the reply on its way to the voice ---------------------------------------------


class Gates:
    """Stands in for the gates: lets everything through and keeps what it read."""

    checks_spoken = True

    def __init__(self) -> None:
        self.spoken_texts: list[str] = []

    async def spoken(self, text: str) -> Decision:
        self.spoken_texts.append(text)
        return ALLOW


class Session:
    """The voice: what it says. A line named in ``cut`` is interrupted."""

    def __init__(self, cut: str | None = None) -> None:
        self.said: list[str] = []
        self.cut = cut

    def say(self, text, *, add_to_chat_ctx, allow_interruptions):
        self.said.append(text)

        async def played():
            return SimpleNamespace(interrupted=text == self.cut)

        return played()

    async def interrupt(self) -> None:
        return None


class Engine:
    """Stands in for the session engine: it is there, and says nothing by itself."""

    def opening(self) -> Reply:
        return Reply()

    async def said(self, text: str) -> Reply | None:
        return None


async def stream(*pieces):
    for piece in pieces:
        yield piece


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


async def script(tutor: Tutor, session: Session, *lines: str) -> None:
    """The engine's lines, said by the tutor as the engine wrote them."""
    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
        await tutor._say(tuple(Line(line) for line in lines))


async def test_the_gate_reads_what_is_said_and_that_is_what_is_voiced_and_told_on():
    gates, told = Gates(), []
    usage = llm.ChatChunk(
        id="u",
        usage=llm.CompletionUsage(completion_tokens=1, prompt_tokens=1, total_tokens=2),
    )
    step = stream("Muy bien, ", "Gonzalo. ", "¡Hasta pronto!", usage)

    out = [
        chunk
        async for chunk in checked(step, gates, "es", approved=told.append, kept=closing.without)
    ]

    # One piece of text in place of the model's three, and what is not text stays.
    assert out == ["Muy bien, Gonzalo.", usage]
    assert gates.spoken_texts == ["Muy bien, Gonzalo."]
    assert told == ["Muy bien, Gonzalo."]


async def test_a_reply_with_no_goodbye_reaches_the_voice_as_the_model_wrote_it():
    gates = Gates()
    pieces = ("¿Cuántas partes ", "hay en total?")

    out = [chunk async for chunk in checked(stream(*pieces), gates, "es", kept=closing.without)]

    assert out == list(pieces)
    assert gates.spoken_texts == ["¿Cuántas partes hay en total?"]


async def test_in_a_session_the_engine_runs_the_models_goodbye_is_not_said(caplog):
    caplog.set_level("INFO", logger="aule.agent.tutor")
    gates = Gates()
    tutor = Tutor(language="es", gates=gates, engine=Engine())

    said = await reply(
        tutor, "Me gusta tu entusiasmo, Gonzalo. ", "Hoy ya cerramos. ¡Hasta pronto!"
    )

    assert said == "Me gusta tu entusiasmo, Gonzalo."
    assert gates.spoken_texts == ["Me gusta tu entusiasmo, Gonzalo."]
    # Counts only: what was left out is never logged.
    assert "closing sentences left out of a reply" in caplog.text
    assert "Hasta pronto" not in caplog.text and "cerramos" not in caplog.text


async def test_without_an_engine_the_goodbye_is_the_models_to_say():
    tutor = Tutor(language="es", gates=Gates())

    said = await reply(tutor, "Buen trabajo, Gonzalo. ", "¡Hasta pronto!")

    assert said == "Buen trabajo, Gonzalo. ¡Hasta pronto!"


async def test_a_reply_that_is_only_a_goodbye_says_the_engines_last_line_again():
    tutor, session = Tutor(language="es", gates=Gates(), engine=Engine()), Session()
    await script(tutor, session, "Aquí hay 5 partes iguales y 3 están pintadas.", "¿Seguimos?")

    said = await reply(tutor, "Gonzalo, la sesión termina aquí por hoy. ", "¡Hasta pronto!")

    assert said == "¿Seguimos?"


async def test_a_line_the_student_cut_off_or_a_fixed_one_is_not_the_one_said_again():
    redirect = REPLIES["redirect"]["es"]
    tutor = Tutor(language="es", gates=Gates(), engine=Engine())
    await script(tutor, Session(), "Paso 1: ¿en cuántas partes está dividido el círculo?")
    # The hint was interrupted, and the redirect is a fixed line, not the engine's.
    await script(
        tutor, Session(cut="Te ayudo: cuenta los pedazos."), "Te ayudo: cuenta los pedazos."
    )
    await script(tutor, Session(), redirect)

    said = await reply(tutor, "¡Nos vemos pronto!")

    assert said == "Paso 1: ¿en cuántas partes está dividido el círculo?"


async def test_before_the_engine_has_said_anything_a_goodbye_gets_nothing():
    tutor = Tutor(language="es", gates=Gates(), engine=Engine())

    assert await reply(tutor, "¡Hasta pronto, Gonzalo!") == ""


async def test_once_the_engines_activity_is_over_the_goodbye_is_said():
    tutor, session = Tutor(language="es", gates=Gates(), engine=Engine()), Session()
    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
        await tutor.scripted_lines(Reply(lines=(Line("Terminamos los ejercicios."),), over=True))

    said = await reply(tutor, "Hoy trabajaste muy bien. ", "¡Hasta pronto, Gonzalo!")

    assert said == "Hoy trabajaste muy bien. ¡Hasta pronto, Gonzalo!"
