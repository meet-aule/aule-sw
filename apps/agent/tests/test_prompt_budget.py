"""What every call to the tutor's model carries: its instructions and its tools.

Both are paid on every turn and both slow the first word, so they must not
grow unnoticed. The budgets sit a little above today's size: a change that
needs more raises them here, on purpose, with a reason in its pull request.
"""

import json

import pytest

from aule_agent.tutor import Tutor

INSTRUCTIONS_BUDGET = 4_000  # characters of static policy, including the final language rule
TOOLS_BUDGET = 9_000  # characters of the tools' JSON (8,361)


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
