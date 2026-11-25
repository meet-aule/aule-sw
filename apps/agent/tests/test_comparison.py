import json

import jsonschema
import pytest

from aule_agent.comparison import SCHEMA, compare
from aule_agent.safety import Gates
from aule_agent.tutor import INSTRUCTIONS, Tutor


@pytest.mark.parametrize(
    "left,right,relation",
    [
        ("2/29", "1/15", "greater_than"),
        ("2/29", "1/14", "less_than"),
        ("2/39", "1/20", "greater_than"),
        ("2/4", "0.5", "equal"),
        ("0.1", "1/10", "equal"),
        ("-1/2", "-0.25", "less_than"),
        ("1/-2", "-0.5", "equal"),
        ("9007199254740993", "9007199254740992", "greater_than"),
        ("-0", "+0", "equal"),
    ],
)
def test_comparisons_are_exact(left: str, right: str, relation: str) -> None:
    result = json.loads(compare(left, right))
    assert result["verified"] is True
    assert result["relation"] == relation


def test_adding_tops_and_bottoms_lands_between_these_addends_not_below_both() -> None:
    for denominator in range(2, 100):
        wrong = f"2/{2 * denominator + 1}"
        assert json.loads(compare(wrong, f"1/{denominator}"))["relation"] == "less_than"
        assert json.loads(compare(wrong, f"1/{denominator + 1}"))["relation"] == "greater_than"


@pytest.mark.parametrize(
    "invalid",
    [
        None,
        True,
        0.5,
        {},
        "",
        "1/0",
        "NaN",
        "inf",
        "1e3",
        "1 + 2",
        "1 1/2",
        "half",
        "1/2 < 1",
        "__import__('os')",
        "9" * 19,
        "0." + "1" * 19,
        " " * 41,
    ],
)
def test_unsupported_values_cannot_produce_a_verified_relation(invalid: object) -> None:
    for left, right in [(invalid, "1"), ("1", invalid)]:
        result = json.loads(compare(left, right))
        assert result["verified"] is False
        assert "relation" not in result


async def test_the_real_tool_checks_without_a_platform_and_does_not_leak_an_answer() -> None:
    tutor = Tutor(language="es", gates=Gates())
    tool = next(tool for tool in tutor.tools if tool.info.name == "compare_numbers")
    args = {"left": "2/29", "right": "1/15"}
    jsonschema.validate(args, SCHEMA["parameters"])
    result = json.loads(await tool(args))
    assert result == {"verified": True, "left": "2/29", "relation": "greater_than", "right": "1/15"}
    assert json.loads(await tool({"left": "2/29"}))["verified"] is False
    assert all("compare_numbers" in INSTRUCTIONS[language] for language in ("es", "en"))
