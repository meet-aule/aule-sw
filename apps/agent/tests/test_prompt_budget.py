"""What every call to the tutor's model carries: its instructions and its tools.

Both are paid on every turn and both slow the first word, so they must not
grow unnoticed. The budgets sit a little above today's size: a change that
needs more raises them here, on purpose, with a reason in its pull request.
"""

import json

import pytest

from aule_agent.tutor import Tutor

# Characters of static policy in the most complete session, the final language
# rule included: es 4,214 and en 4,205, with the analogy rule, the checking rule
# for answers checked in code, the reply-length rule (#225) and the screen rule
# of the 2026-11-25 test session (every exercise and example is shown). Raised on
# purpose: from 4,000 when the analogy and checking rules, approved together on
# 2026-11-25, did not fit beside the length rule; from 4,100 for the screen rule.
INSTRUCTIONS_BUDGET = 4_250
TOOLS_BUDGET = 9_000  # characters of the tools' JSON (8,971)


class Gates:
    checks_spoken = True


class Checker: ...


async def screen(visual): ...


def complete(language):
    return Tutor(language=language, gates=Gates(), show=screen, checker=Checker(), breaks=True)


@pytest.mark.parametrize("language", ["es", "en"])
def test_the_instructions_stay_within_their_budget(language):
    instructions = complete(language).instructions
    assert len(instructions) <= INSTRUCTIONS_BUDGET, len(instructions)
    # Nothing half-assembled: no template braces, no empty sections.
    assert "{" not in instructions and "}" not in instructions
    assert "\n\n\n" not in instructions


def test_the_tools_stay_within_their_budget():
    tools = complete("es").tools
    size = sum(len(json.dumps(tool.info.raw_schema, ensure_ascii=False)) for tool in tools)
    assert size <= TOOLS_BUDGET, size


@pytest.mark.parametrize("language", ["es", "en"])
def test_one_analogy_rule_keeps_the_exercises_operations_among_the_teaching_rules(language):
    instructions = complete(language).instructions
    teaching = instructions.index("How you teach:")
    speaking = instructions.index("How you speak:")
    rule = instructions.index(
        "- In analogies, preserve the operation, order and quantities, each number in its role"
    )
    # One rule, which every call carries: no second one on analogies elsewhere.
    assert instructions.lower().count("analog") == 1
    assert (
        teaching
        < rule
        < instructions.index("if the exercise adds, everything is put together")
        < instructions.index("nothing bought, spent, eaten or given away")
        < instructions.index("Use different numbers for worked examples.")
        < speaking
    )
