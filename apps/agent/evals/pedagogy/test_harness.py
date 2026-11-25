"""The evaluation's turn, offline: a real AgentSession, a model that answers
from a script, gates that let everything through, and the checker stand-in
with canned readings instead of the compiled one."""

import json

from evaluate import Checker, play
from livekit.agents import AgentSession, llm
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS, NOT_GIVEN
from report import checks

from aule_agent.moderation import Action, Decision
from aule_agent.tutor import Tutor

READINGS = {"56": "incorrect", "no sé": "dont_know", "31": "correct"}


class Gates:
    checks_spoken = True

    async def heard(self, context, message):
        return Decision(Action.ALLOW)

    async def spoken(self, text):
        return Decision(Action.ALLOW)


class Canned(Checker):
    def read(self, expression, said="", form="any"):
        verdict = next((v for key, v in READINGS.items() if key in said), "unreadable")
        return dict(answer="31", verdict=verdict, misconception=None, gives_away=False)


class Script(llm.LLMStream):
    def __init__(self, model, *, text, **kwargs):
        super().__init__(model, **kwargs)
        self._text = text

    async def _run(self):
        delta = llm.ChoiceDelta(role="assistant", content=self._text)
        self._event_ch.send_nowait(llm.ChatChunk(id="step", delta=delta))


class Model(llm.LLM):
    def __init__(self, *replies):
        super().__init__()
        self.replies = list(replies)

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
        text = self.replies.pop(0)
        return Script(
            self, text=text, chat_ctx=chat_ctx, tools=tools or [], conn_options=conn_options
        )


async def test_each_turn_is_typed_through_the_gates_checked_in_code_and_recorded(tmp_path):
    checker = Canned(tmp_path / "no-binary")
    tutor = Tutor(language="es", gates=Gates(), checker=checker)
    model = Model("¿Qué harías primero?", "Mira estas figuritas.", "¡Eso es!")
    turns = [
        "Estoy haciendo 25 + 3 * 2. Me salió 56 porque primero sumé. ¿Está bien?",
        "No entiendo. Explícamelo de otra manera, con algo más fácil.",
        "Creo que la respuesta al ejercicio original es 31.",
    ]

    async with AgentSession(llm=model, user_away_timeout=None) as session:
        await session.start(agent=tutor, session_host=False)
        await checker.pose("25 + 3 * 2")
        played = []
        for utterance in turns:
            played.append(dict(student=utterance, tools=[]) | await play(tutor, checker, utterance))

    assert [turn["error"] for turn in played] == [None, None, None]
    assert [turn["assistant"] for turn in played] == [
        ["¿Qué harías primero?"],
        ["Mira estas figuritas."],
        ["¡Eso es!"],
    ]
    assert [turn["check"]["kind"] for turn in played] == ["answer", "help", "answer"]
    assert all(turn["check"]["by"] == ["code"] and turn["check"]["open_before"] for turn in played)
    assert not any(turn["check"]["failed"] for turn in played)
    said = [json.loads(turn["function_events"][0]["arguments"])["said"] for turn in played]
    assert said[1] == "no sé" and said[0].startswith("Estoy haciendo .")
    assert [event["verdict"] for event in checker.events[1:]] == [
        "incorrect",
        "dont_know",
        "correct",
    ]
    # The correct answer closed the exercise.
    assert checker.exercise is None
    played[0]["tools"] = checker.events[1:2]
    assert checks(dict(turns=played))["complete"]
