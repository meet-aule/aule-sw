"""Answers the student can tap under the tutor's question.

A few short options (``contracts/choices/choices.v1.schema.json``) that a
screen with a conversation shows under the line that asked. Tapping one is the
student's turn: the screen sends its words as a typed message, so they pass
the input gates like anything typed (``Tutor.typed``); several marked go as
one turn, joined by commas.

The session engine's lines carry their own (``script.Line``), its fixed words,
which go up once their line has been heard.
"""

import json
from functools import cache
from typing import Any

from jsonschema import Draft202012Validator

from .events import contracts_dir

# The room's text-stream topic choices travel on.
TOPIC = "aule.choices"


@cache
def schema() -> dict[str, Any]:
    path = contracts_dir() / "choices" / "choices.v1.schema.json"
    return json.loads(path.read_text(encoding="utf-8"))


@cache
def _validator() -> Draft202012Validator:
    return Draft202012Validator(schema())


def problems(choices: object) -> list[str]:
    """Why this is not something a screen can offer. Empty when it is."""
    return [error.message for error in _validator().iter_errors(choices)]
