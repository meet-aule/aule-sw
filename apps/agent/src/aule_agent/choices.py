"""Answers the student can tap under the tutor's question.

A few short options (``contracts/choices/choices.v1.schema.json``) that a
screen with a conversation shows under the line that asked. Tapping one is the
student's turn: the screen sends its words as a typed message, so they pass
the input gates like anything typed (``Tutor.typed``); several marked go as
one turn, joined by commas.

The session engine's lines carry their own (``script.Line``), its fixed words.
The tutor's model offers them with ``offer_choices``: what it wrote passes the
gate on what is spoken before any screen gets it, and goes up only once the
question it belongs to has passed that gate too and been heard.
"""

import json
from dataclasses import dataclass
from functools import cache
from typing import Any

from jsonschema import Draft202012Validator

from .events import contracts_dir

# The room's text-stream topic choices travel on.
TOPIC = "aule.choices"

DESCRIPTION = (
    "Show answers the student can tap under the question you ask next, when it has a few "
    "possible answers: 2 to 4 short options. With multiple they can mark several and send "
    'them together, for "mark all that...". Then ask the question aloud, naming the '
    "options. What they tap reaches you as their answer."
)

# The tool as the model sees it. Written by hand, with nothing nullable (the
# model's API refuses that), and narrower than the contract: the engine may
# offer a single option, the model offers a choice between two or more.
TOOL: dict[str, Any] = {
    "name": "offer_choices",
    "description": DESCRIPTION,
    "parameters": {
        "type": "object",
        "properties": {
            "options": {
                "type": "array",
                "items": {"type": "string", "maxLength": 40},
                "minItems": 2,
                "maxItems": 4,
            },
            "multiple": {"type": "boolean"},
        },
        "required": ["options", "multiple"],
    },
}

# What the model reads once its options are kept for its question.
OFFERED = "They show under your question once you have said it. Ask it now, naming the options."


@cache
def schema() -> dict[str, Any]:
    path = contracts_dir() / "choices" / "choices.v1.schema.json"
    return json.loads(path.read_text(encoding="utf-8"))


@cache
def _validator() -> Draft202012Validator:
    return Draft202012Validator(schema())


@cache
def _tool_validator() -> Draft202012Validator:
    return Draft202012Validator(TOOL["parameters"])


def problems(choices: object) -> list[str]:
    """Why this is not something a screen can offer. Empty when it is."""
    return [error.message for error in _validator().iter_errors(choices)]


def from_tool(arguments: object) -> dict[str, Any]:
    """The model's call as choices for the screen. Raises ``ValueError`` with
    the reason when it cannot be one, which the model is told."""
    if isinstance(arguments, dict) and isinstance(arguments.get("options"), list):
        # « Sí » is the option «Sí».
        trimmed = [o.strip() if isinstance(o, str) else o for o in arguments["options"]]
        arguments = {**arguments, "options": trimmed}
    found = [error.message for error in _tool_validator().iter_errors(arguments)]
    if found:
        raise ValueError(found[0])
    assert isinstance(arguments, dict)
    offered = {"options": arguments["options"], "multiple": arguments["multiple"]}
    found = problems(offered)
    if found:
        raise ValueError(found[0])
    return offered


def text_of(choices: dict[str, Any]) -> str:
    """Every word the student would read, for the gate on what the tutor says."""
    return "\n".join(choices["options"])


@dataclass
class Asked:
    """Choices the model offered for the question it is about to ask, until
    that reply is over. ``approved`` once the reply passed the output gate
    with words in it: without them there is no question to put them under."""

    choices: dict[str, Any]
    approved: bool = False
