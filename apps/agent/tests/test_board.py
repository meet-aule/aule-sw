"""The real voice/typed turn entry points and show tool with a synthetic screen."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, PropertyMock, patch
from uuid import uuid4

import latency_harness as harness
import pytest
from fakes import TOOL_ARGUMENTS, Delays, TurnPlan, World, words_of
from livekit.agents import ModelSettings, llm
from test_config import COMPLETE
from test_tutor import (
    ALLOW,
    HAZARD,
    ScriptedEngine,
    ScriptedGates,
    Session,
    hear,
    scripted_turn,
    tool,
    type_to,
)

from aule_agent import board, visuals
from aule_agent.config import Settings
from aule_agent.events import contracts_dir
from aule_agent.prompts import response_language
from aule_agent.script import Line, Reply
from aule_agent.tutor import Tutor

LESSONS = json.loads((contracts_dir() / "board" / "lesson.v1.example.json").read_text())


class Screen:
    def __init__(self):
        self.scene = self.point = None
        self.revision = str(uuid4())
        self.actions = 0

    def point_at(self, part):
        self.point = part
        self.revision = str(uuid4())

    async def exchange(self, request):
        accepted = request.get("expect") == self.revision
        if accepted:
            self.actions += 1
            self.scene = request["scene"]
            self.point_at(self.point if request["keepPoint"] else None)
        view = {"scene": self.scene, "point": self.point, "revision": self.revision}
        return json.dumps({"applied": accepted, "view": view})


def test_only_the_pilot_extends_the_existing_show_tool():
    assert not Settings.from_env(COMPLETE).progressive_board
    assert Settings.from_env({**COMPLETE, "AULE_PROGRESSIVE_BOARD": "1"}).progressive_board
    assert "change" not in visuals.tool_schema()["parameters"]["properties"]
    assert (
        visuals.tool_schema(progressive=True)["parameters"]["properties"]["step"]
        == (visuals.tool_schema()["parameters"]["properties"]["step"])
    )
    assert (
        "board_step"
        in visuals.tool_schema(progressive=True)["parameters"]["properties"]["kind"]["enum"]
    )


async def test_the_existing_fraction_show_draws_just_one_new_row_per_answer():
    screen = Screen()
    tutor = Tutor(
        language="es",
        gates=ScriptedGates(*[ALLOW] * 8),
        show=AsyncMock(),
        board_exchange=screen.exchange,
    )
    show = tool(tutor, "show")
    both = {
        "kind": "fraction_bars",
        "fractions": [
            {"numerator": 1, "denominator": 2},
            {"numerator": 2, "denominator": 4},
        ],
    }
    for count in (1, 2):
        assert await hear(tutor, Session(), "Mira las barras.")
        assert "Visible board" in await show(both)
        assert screen.scene == LESSONS["fraction"][count - 1]["scene"]
    screen.point_at("r2c3")
    assert await hear(tutor, Session(), "¿Por qué esta?")
    assert "r2c3" in await show(both)
    assert screen.actions == 2


@pytest.mark.parametrize("language", ["es", "en"])
@pytest.mark.parametrize(
    "lesson,part,meaning",
    [
        ("fraction", "r2c3", "row 2, cell 3 of 4, unshaded"),
        ("perimeter", "right", "right side (3 cm)"),
    ],
)
async def test_progression_and_the_next_voice_prompt(language, lesson, part, meaning):
    screen = Screen()
    tutor = Tutor(
        language=language,
        gates=ScriptedGates(*[ALLOW] * 12),
        show=AsyncMock(),
        board_exchange=screen.exchange,
    )
    show = tool(tutor, "show")
    for item in LESSONS[lesson]:
        assert await hear(tutor, Session(), "Quiero probar.")
        result = await show({"kind": "board_step", "change": item["step"]})
        assert "Visible board:" in result
        assert screen.scene == item["scene"]
        count = screen.actions
        assert "wait" in await show({"kind": "board_step", "change": item["step"]})
        assert screen.actions == count
    screen.point_at(part)
    await type_to(tutor, Session(), "¿Por qué esta?")
    assert meaning in tutor._prompt().notes
    assert tutor._prompt().text.endswith(response_language(language))
    assert screen.actions == len(LESSONS[lesson])
    assert await hear(tutor, Session(), "¿Por qué esta?")
    assert meaning in tutor._prompt().notes


async def test_interruption_while_output_gate_is_pending_keeps_the_last_visible_scene():
    screen, gates = Screen(), ScriptedGates(*[ALLOW] * 8)
    tutor = Tutor(language="es", gates=gates, show=AsyncMock(), board_exchange=screen.exchange)
    show = tool(tutor, "show")
    first, second, *_ = LESSONS["fraction"]
    assert await hear(tutor, Session(), "Una mitad")
    await show({"kind": "board_step", "change": first["step"]})
    assert await hear(tutor, Session(), "Continúa")
    started, finish = asyncio.Event(), asyncio.Event()

    async def held(_):
        started.set()
        await finish.wait()
        return ALLOW

    gates.spoken = held
    pending = asyncio.create_task(show({"kind": "board_step", "change": second["step"]}))
    await started.wait()
    assert "wait" in await show({"kind": "board_step", "change": second["step"]})
    tutor.hold_started()
    finish.set()
    assert "wait" in await pending
    assert screen.scene == first["scene"]
    assert await hear(tutor, Session(), "Un momento")
    assert "1/2" in tutor._prompt().notes and "2/4" not in tutor._prompt().notes


async def test_a_new_click_rejects_an_old_step_and_a_denied_step_is_never_displayed():
    screen, gates = Screen(), ScriptedGates(ALLOW, ALLOW, ALLOW, ALLOW, ALLOW, HAZARD)
    tutor = Tutor(language="es", gates=gates, show=AsyncMock(), board_exchange=screen.exchange)
    first, second, *_ = LESSONS["fraction"]
    show = tool(tutor, "show")
    assert await hear(tutor, Session(), "Dibuja")
    await show({"kind": "board_step", "change": first["step"]})
    assert await hear(tutor, Session(), "Continúa")
    screen.point_at("r1c2")
    assert "Learner selected: r1c2" in await show({"kind": "board_step", "change": second["step"]})
    assert await hear(tutor, Session(), "Ahora sí")
    assert "withheld" in await show({"kind": "board_step", "change": second["step"]})
    assert screen.scene == first["scene"] and screen.actions == 1


def test_only_existing_bounded_parts_and_numbers_can_enter_a_model_request():
    revision = str(uuid4())
    scene = {"kind": "bars", "rows": [[1, 2]]}
    raw = {"revision": revision, "scene": scene, "point": "r1c2"}
    view = board.View.read(raw)
    assert view
    for point in ["r1c3", "r4c1", "top", "arbitrary text"]:
        assert board.View.read({**raw, "point": point}) is None
    assert board.View.read({**raw, "scene": {**scene, "note": "text"}}) is None
    assert board.View.read({**raw, "scene": {**scene, "rows": [[3, 2]]}}) is None
    for step in [
        {"action": "mark", "part": "right"},
        {"action": "add_bar", "numerator": 8, "denominator": 4},
    ]:
        with pytest.raises(ValueError):
            view.advance(step)


@pytest.mark.parametrize("legacy", [False, True])
async def test_only_an_explicitly_older_screen_receives_the_legacy_visual_stream(legacy):
    sent = AsyncMock(return_value=None)
    exchange = AsyncMock(return_value='{"unsupported":true}' if legacy else "")
    tutor = Tutor(
        language="es", gates=ScriptedGates(ALLOW, ALLOW), show=sent, board_exchange=exchange
    )
    assert await hear(tutor, Session(), "Mira")
    visual = {"kind": "rectangle", "width": 8, "height": 3, "unit": "cm"}
    await tool(tutor, "show")(visual)
    assert sent.await_count == int(legacy)


@pytest.mark.parametrize("permission", ["identify", "off"])
async def test_the_engine_controls_board_help_in_an_assessment_or_break(permission):
    screen = Screen()
    screen.scene = LESSONS["perimeter"][0]["scene"]
    screen.point_at("right")
    engine = ScriptedEngine(
        (), Reply(converse="Follow the current exercise.", board_help=permission)
    )
    tutor = Tutor(
        language="es",
        gates=ScriptedGates(ALLOW),
        engine=engine,
        show=AsyncMock(),
        board_exchange=screen.exchange,
    )
    free, _ = await scripted_turn(tutor, Session(), "¿Por qué este lado?")
    assert free and "opposite" not in tutor._prompt().notes
    assert tutor._turn.board_reply == (
        "Señalaste el lado derecho." if permission == "identify" else ""
    )
    await tool(tutor, "show")({"kind": "board_step", "change": {"action": "mark", "part": "top"}})
    assert screen.actions == 0


@pytest.mark.parametrize("mode", ["push-to-talk", "open-mic"])
async def test_the_worker_carries_a_tap_to_the_next_real_livekit_voice_turn(monkeypatch, mode):
    world = World(seed=51, delays=Delays(scale=0.05))
    screen = Screen()
    linked = SimpleNamespace(identity="learner", sid="one-connection")
    monkeypatch.setattr(
        harness.OfflineSession,
        "room_io",
        property(lambda _: SimpleNamespace(linked_participant=linked)),
    )

    async def rpc(_, *, destination_identity, method, payload, response_timeout):
        assert destination_identity == linked.identity and method == board.RPC
        request = json.loads(payload)
        if request.get("read") and screen.scene:
            screen.point_at("r1c2")
        return await screen.exchange(request)

    monkeypatch.setattr(harness.Local, "perform_rpc", rpc, raising=False)
    first = LESSONS["fraction"][0]
    monkeypatch.setitem(
        TOOL_ARGUMENTS,
        "show",
        lambda _: json.dumps({"kind": "board_step", "change": first["step"]}),
    )
    ask, point = words_of(1), words_of(2)
    world.plans[ask] = TurnPlan(reply="", tool="show", reply_after_tool="¿Qué observas?")
    world.plans[point] = TurnPlan(reply="Esa parte está sin pintar.")
    turns = [
        harness.Turn(1, "tool", ask, 0.4, 0.4, "show"),
        harness.Turn(2, "reply", point, 0.4, 0.4),
    ]
    with harness.offline({"AULE_PROGRESSIVE_BOARD": "1"}, mode=mode):
        await harness.run_session(world, turns, mode=mode, gap=(0.01, 0.01))
    assert screen.actions == 1 and screen.scene == first["scene"]
    assert any(
        "row 1, cell 2 of 2, unshaded" in json.dumps(call.kwargs, default=str)
        for call in world.model_calls
    )


@pytest.mark.parametrize(
    "language,lesson,point,question,expected",
    [
        (
            "es",
            "fraction",
            "r2c3",
            "¿Por qué esta parte quedó sin pintar?",
            "parte 3 de la barra 2",
        ),
        ("es", "fraction", "r2c3", "Porque esta parte quedó sin pintar.", "parte 3 de la barra 2"),
        ("en", "fraction", "r2c3", "Why this one?", "part 3 of bar 2"),
        ("es", "perimeter", "right", "¿Por qué este lado mide eso?", "lado derecho"),
        ("en", "perimeter", "right", "Why this side?", "right side"),
    ],
)
async def test_a_deictic_question_is_spoken_from_the_confirmed_point_without_inference(
    language, lesson, point, question, expected
):
    screen = Screen()
    screen.scene = LESSONS[lesson][-1]["scene"]
    screen.point_at(point)
    gates = ScriptedGates(ALLOW, ALLOW)
    tutor = Tutor(language=language, gates=gates, show=AsyncMock(), board_exchange=screen.exchange)
    assert await hear(tutor, Session(), question)
    utterance = "".join(
        [s async for s in tutor.llm_node(llm.ChatContext.empty(), [], ModelSettings())]
    )
    assert expected in utterance and gates.spoken_texts == [utterance] and screen.actions == 0
    if lesson == "perimeter":
        assert ("3 centímetros" if language == "es" else "3 centimetres") in utterance
    assert (
        tutor._turn.view.reference_reply(
            "Why are these fractions equivalent?", language, identify_only=False
        )
        == ""
    )
    assert len(tutor._turn.view.reference_reply(question, language, identify_only=True)) < len(
        utterance
    )


async def test_a_denied_reference_cannot_reach_the_speaker():
    screen = Screen()
    screen.scene = LESSONS["perimeter"][0]["scene"]
    screen.point_at("right")
    tutor = Tutor(
        language="es",
        gates=ScriptedGates(ALLOW, HAZARD),
        show=AsyncMock(),
        board_exchange=screen.exchange,
    )
    assert await hear(tutor, Session(), "¿Por qué este lado?")
    utterance = "".join(
        [s async for s in tutor.llm_node(llm.ChatContext.empty(), [], ModelSettings())]
    )
    assert utterance and "derecho" not in utterance


async def test_a_card_submission_can_draw_after_an_interrupted_voice_turn():
    before, after = str(uuid4()), str(uuid4())
    scene = LESSONS["perimeter"][0]["scene"]
    visual = {**scene, "unit": "cm"}
    exchange = AsyncMock(
        side_effect=[
            json.dumps({"view": {"revision": before, "point": None, "scene": None}}),
            json.dumps(
                {"applied": True, "view": {"revision": after, "point": None, "scene": scene}}
            ),
        ]
    )
    tutor = Tutor(language="es", gates=ScriptedGates(), show=AsyncMock(), board_exchange=exchange)
    session = Session()
    tutor.hold_started()
    with patch.object(Tutor, "session", new_callable=PropertyMock, return_value=session):
        await tutor.scripted_lines(Reply(lines=(Line("Mira el rectángulo.", show=visual),)))
    assert exchange.await_args.args[0] == {"expect": before, "replace": visual}
    assert session.said == [("Mira el rectángulo.", True, True)]
