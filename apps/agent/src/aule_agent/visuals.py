"""What the tutor shows on the student's screen.

A visual is a small description (an exercise to read, fraction bars, a number
line...) that the screen draws itself. Nothing is generated as an image, so
showing one is immediate and costs nothing to draw. Its shape is fixed by
``contracts/visuals/visual.v1.schema.json``, which is also the schema of the
tutor's ``show`` tool: the model can only ask for what a screen can draw.
"""

import json
from functools import cache
from typing import Any

from jsonschema import Draft202012Validator

from .events import contracts_dir

# The room's text-stream topic visuals travel on.
TOPIC = "aule.visual"

DESCRIPTION = (
    "Show something on the student's screen while you keep talking. Use it for every exercise "
    "and example you give. Each call replaces what was on the screen. Never show the answer "
    "to what you are asking, and do not draw the "
    "part of a diagram that gives it away (for 8 + 6 on a number line, mark 8 only). Choose a "
    "kind and give "
    "what it needs: exercise needs lines; fraction_bars and fraction_circle (a pie) need "
    "fractions; number_line needs "
    "from, to and step (marks and jumps are optional); dot_array needs rows and columns; "
    "counters needs groups (each a count and a fill, solid or open, for a bag of things); "
    "table needs headers and cells; bar_chart needs bars; rectangle needs width and height; "
    "polygon draws any straight-sided shape and needs exactly one of: regular (how many "
    "equal sides: 6 is a hexagon; side is their length), sides (a triangle from three "
    "lengths: base, left, right) or points (the corners in order, for a trapezoid or any "
    "other shape); labels can replace a length with ? or a name; clock draws a clock face "
    "and needs hour (1 to 12; minute is optional). "
    "title is optional for every kind."
)


@cache
def schema() -> dict[str, Any]:
    path = contracts_dir() / "visuals" / "visual.v1.schema.json"
    return json.loads(path.read_text(encoding="utf-8"))


@cache
def _validator() -> Draft202012Validator:
    return Draft202012Validator(schema())


# Kinds the agent draws itself from a measurement, never the model: the tune
# of the student's voice in a pronunciation drill.
DRAWN_BY_THE_AGENT = {"contour": ("count", "segments", "expected")}


def tool_schema() -> dict[str, Any]:
    """The ``show`` tool as the model sees it.

    The model's API refuses ``allOf`` at the top of a tool's schema, so the rule
    for what each kind needs is in the description instead; ``problems`` still
    checks every call against the whole contract.
    """
    whole = schema()
    hidden = {field for fields in DRAWN_BY_THE_AGENT.values() for field in fields}
    properties = {key: value for key, value in whole["properties"].items() if key not in hidden}
    kinds = [kind for kind in whole["properties"]["kind"]["enum"] if kind not in DRAWN_BY_THE_AGENT]
    properties["kind"] = {**whole["properties"]["kind"], "enum": kinds}
    parameters = {
        key: value
        for key, value in whole.items()
        if not key.startswith("$") and key not in ("allOf", "properties")
    }
    parameters["properties"] = properties
    return {"name": "show", "description": DESCRIPTION, "parameters": parameters}


def problems(visual: object) -> list[str]:
    """Why this is not a visual a screen can draw. Empty when it is one."""
    found = [error.message for error in _validator().iter_errors(visual)]
    if not found and isinstance(visual, dict) and visual.get("kind") == "number_line":
        if not visual["to"] > visual["from"]:
            found.append("to must be greater than from")
    if not found and isinstance(visual, dict) and visual.get("kind") == "polygon":
        found += _polygon_problems(visual)
    return found


def _polygon_problems(visual: dict[str, Any]) -> list[str]:
    """What the schema cannot say about a polygon: its lengths or corners must close a shape."""
    if "sides" in visual:
        longest = max(visual["sides"])
        if longest >= sum(visual["sides"]) - longest:
            return ["those sides do not make a triangle: the longest is too long"]
    if "points" in visual:
        points = visual["points"]
        # Twice the area, by the shoelace rule: zero when the corners are in a line.
        doubled = sum(
            x1 * y2 - x2 * y1
            for (x1, y1), (x2, y2) in zip(points, points[1:] + points[:1], strict=True)
        )
        if abs(doubled) < 1e-9:
            return ["those points do not make a shape: they are in a line"]
    return []


def text_of(visual: dict[str, Any]) -> str:
    """Every word the student would read, for the gate on what the tutor says."""
    words: list[str] = []

    def collect(value: object) -> None:
        if isinstance(value, str):
            words.append(value)
        elif isinstance(value, list):
            for item in value:
                collect(item)
        elif isinstance(value, dict):
            for key, item in value.items():
                if key != "kind":
                    collect(item)

    collect(visual)
    return " ".join(words)
