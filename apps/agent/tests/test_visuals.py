import json

import pytest

from aule_agent import visuals
from aule_agent.events import contracts_dir
from aule_agent.moderation import Action, Decision
from aule_agent.prompts import response_language
from aule_agent.tutor import SCREEN, SHOWN, Tutor, present

EXAMPLES = sorted((contracts_dir() / "visuals" / "examples").glob("*.json"))


def example(name: str) -> dict:
    return json.loads((contracts_dir() / "visuals" / "examples" / f"{name}.json").read_text())


class Gate:
    """Stands in for the gates: says yes or no and keeps what it was asked."""

    def __init__(self, allowed: bool = True) -> None:
        self.allowed = allowed
        self.asked: list[str] = []

    async def spoken(self, text: str) -> Decision:
        self.asked.append(text)
        return Decision(Action.ALLOW) if self.allowed else Decision(Action.REDIRECT, "redirect")


class Screen:
    def __init__(self) -> None:
        self.shown: list[dict] = []

    async def __call__(self, visual: dict) -> None:
        self.shown.append(visual)


@pytest.mark.parametrize("path", EXAMPLES, ids=lambda path: path.stem)
def test_every_example_of_the_contract_is_a_visual(path):
    assert visuals.problems(json.loads(path.read_text(encoding="utf-8"))) == []


def test_there_is_an_example_of_every_kind():
    assert {path.stem for path in EXAMPLES} == set(visuals.schema()["properties"]["kind"]["enum"])


@pytest.mark.parametrize(
    "visual",
    [
        {"kind": "hologram"},
        {"kind": "fraction_bars"},
        {"kind": "fraction_bars", "fractions": [{"numerator": 1, "denominator": 0}]},
        {"kind": "dot_array", "rows": 3, "columns": 40},
        {"kind": "fraction_circle"},
        {"kind": "counters"},
        {"kind": "counters", "groups": [{"count": 2, "fill": "striped"}]},
        {"kind": "exercise", "lines": ["2 + 2 = ?"], "html": "<b>x</b>"},
        {"kind": "number_line", "from": 10, "to": 0, "step": 1},
        {"kind": "polygon"},
        {"kind": "polygon", "regular": 6, "sides": [3, 4, 5]},
        {"kind": "polygon", "regular": 40},
        {"kind": "polygon", "sides": [1, 2, 10]},
        {"kind": "polygon", "points": [[0, 0], [1, 1], [2, 2]]},
        {"kind": "clock"},
        {"kind": "clock", "hour": 13},
        {"kind": "clock", "hour": 3, "minute": 60},
        "fraction bars please",
        None,
    ],
)
def test_what_a_screen_cannot_draw_is_refused(visual):
    assert visuals.problems(visual)


def test_the_tool_is_the_contract():
    tool = visuals.tool_schema()

    assert tool["name"] == "show"
    contract = visuals.schema()["properties"]
    # Every field of the contract, except what only the agent draws.
    hidden = {field for fields in visuals.DRAWN_BY_THE_AGENT.values() for field in fields}
    shown = {key: value for key, value in contract.items() if key not in hidden | {"kind"}}
    assert {k: v for k, v in tool["parameters"]["properties"].items() if k != "kind"} == shown
    kinds = tool["parameters"]["properties"]["kind"]["enum"]
    assert set(kinds) == set(contract["kind"]["enum"]) - set(visuals.DRAWN_BY_THE_AGENT)
    assert tool["parameters"]["required"] == ["kind"]
    # The model's API refuses these at the top of a tool's schema.
    assert not any(key.startswith("$") for key in tool["parameters"])
    assert not {"allOf", "anyOf", "oneOf"} & set(tool["parameters"])
    for kind in visuals.schema()["properties"]["kind"]["enum"]:
        if kind in visuals.DRAWN_BY_THE_AGENT:
            continue
        assert kind in tool["description"], f"the description must say what {kind} needs"


def test_the_words_on_the_screen_are_all_collected():
    text = visuals.text_of(example("table"))

    assert "Balones" in text and "Precio (S/)" in text and "24" in text
    assert "table" not in text, "the kind is not something the student reads"
    assert visuals.text_of({"kind": "dot_array", "rows": 3, "columns": 4}) == ""


async def test_a_good_visual_is_shown_and_the_tutor_is_asked_to_say_what_it_is():
    gate, screen = Gate(), Screen()

    told = await present(example("fraction_bars"), gate, screen)
    # What the model reads next is an instruction, not words of the student.
    assert told == SHOWN and isinstance(told, str) and "on the screen" in told

    assert screen.shown == [example("fraction_bars")]
    assert gate.asked == ["¿Cuál es mayor? 2/4"]


async def test_a_visual_that_cannot_be_drawn_is_not_shown_and_the_model_is_told_why():
    gate, screen = Gate(), Screen()

    answer = await present({"kind": "dot_array", "rows": 3}, gate, screen)

    assert answer.startswith("Not shown: ")
    assert "columns" in answer
    assert screen.shown == [] and gate.asked == [], "nothing is checked or sent"


async def test_text_the_gate_stops_never_reaches_the_screen():
    gate, screen = Gate(allowed=False), Screen()

    answer = await present({"kind": "exercise", "lines": ["something unkind"]}, gate, screen)

    assert answer == "Not shown: that text cannot be put on the screen."
    assert screen.shown == []


def test_the_tutor_only_talks_about_a_screen_when_there_is_one():
    without = Tutor(language="es", gates=Gate())
    with_screen = Tutor(language="es", gates=Gate(), show=Screen(), context="Plan: fracciones")

    # Comparison and pronunciation tools are independent of a screen.
    always = ["compare_numbers", "pose_phrase", "check_phrase"]
    assert [tool.info.name for tool in without.tools] == always
    assert SCREEN not in without.instructions
    assert [tool.info.name for tool in with_screen.tools] == [
        "compare_numbers",
        "show",
        "pose_phrase",
        "check_phrase",
    ]
    assert SCREEN in with_screen.instructions
    assert "Plan: fracciones" in with_screen.instructions


@pytest.mark.parametrize("language", ["es", "en"])
def test_with_a_screen_each_exercise_and_example_is_shown_and_the_exercise_again_after(language):
    without = Tutor(language=language, gates=Gate())
    with_screen = Tutor(language=language, gates=Gate(), show=Screen())

    # Examples told and never drawn left the child without seeing what they
    # meant (the test session of 2026-11-25); one drawn over the exercise
    # would leave the wrong numbers up when the tutor returns to it.
    for rule in (
        "Use show for every exercise and example you give, and whenever a visual helps:",
        "If you showed something else, show the exercise again when you return to it.",
    ):
        assert with_screen.instructions.count(rule) == 1
        assert rule not in without.instructions
    # The tool says it too, where the model chooses it.
    assert "Use it for every exercise and example you give." in visuals.DESCRIPTION
    # The output-language rule is still the last instruction.
    assert with_screen.instructions.endswith(response_language(language))
