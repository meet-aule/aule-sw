"""One acknowledged whiteboard step per learner turn. Room memory only."""

from __future__ import annotations

import json
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from functools import cache
from typing import Any

from jsonschema import Draft202012Validator

from .closing import plain
from .events import contracts_dir

RPC = "aule.board.v1"
Exchange = Callable[[dict[str, Any]], Awaitable[str]]
RULE = (
    "When an interactive board is available, teach fraction comparisons and rectangle perimeter "
    "with show(kind=board_step, change=...). Start with one bar or rectangle. Ask one question "
    "and stop until the learner responds. Add one bar or mark one visible part on a later turn. "
    "A confirmed tap identifies exactly what 'this' means. Name that part and explain it before "
    "asking a teaching question. Follow the exercise's hint rules. Never draw its answer."
)
TOOL_HELP = (
    ' Interactive example: {"kind":"board_step","change":{"action":"start_bars",'
    '"numerator":1,"denominator":2}} draws the first row. add_bar takes the same numbers. '
    "start_rectangle takes width and height in cm. mark takes part: top, right, bottom, left, "
    "or r2c3 for row 2 cell 3 counting from the left."
)

# These short questions are entirely about the tap. More specific follow-ups go
# to the model with the same confirmed selection.
REFERENCE = re.compile(
    r"(?:y )?por ?que (?:est[aeo]|es[aeo])(?: (?:parte|lado|barra|pedazo))?"
    r"(?: (?:quedo|esta|es) (?:sin pintar|sin sombrear|pintad[ao]|sombread[ao])| mide (?:eso|asi))?"
    r"|(?:and )?why (?:is )?(?:this|that)(?: (?:one|part|side|piece|cell))?"
    r"(?: (?:shaded|unshaded|unpainted|blank|not (?:shaded|painted)|that length))?"
)
SIDES_ES = {"top": "superior", "right": "derecho", "bottom": "inferior", "left": "izquierdo"}
OPPOSITE = {"left": "right", "right": "left", "top": "bottom", "bottom": "top"}


@cache
def validator(name: str) -> Draft202012Validator:
    path = contracts_dir() / "board" / f"{name}.v1.schema.json"
    return Draft202012Validator(json.loads(path.read_text(encoding="utf-8")))


def has_part(scene: dict | None, part: str) -> bool:
    if not scene:
        return False
    if scene["kind"] == "rectangle":
        return part in ("top", "right", "bottom", "left")
    # Only IDs admitted by the schema can reach this function.
    if not part.startswith("r") or "c" not in part:
        return False
    row, cell = (int(n) for n in part[1:].split("c"))
    return row <= len(scene["rows"]) and cell <= scene["rows"][row - 1][1]


@dataclass(frozen=True)
class View:
    revision: str
    scene: dict | None
    point: str | None

    @classmethod
    def read(cls, raw: object) -> View | None:
        if not isinstance(raw, dict) or not validator("view").is_valid(raw):
            return None
        scene, point = raw["scene"], raw["point"]
        if scene:
            if any(n > d for n, d in scene.get("rows", [])):
                return None
            if "mark" in scene and not has_part(scene, scene["mark"]):
                return None
        if point and not has_part(scene, point):
            return None
        return cls(raw["revision"], scene, point)

    @property
    def note(self) -> str:
        return self.describe(explain=True)

    def describe(self, *, explain: bool) -> str:
        if self.scene is None:
            return "Interactive board available. No progressive drawing is visible."
        scene = self.scene
        if scene["kind"] == "rectangle":
            drawing = f"rectangle {scene['width']} cm wide by {scene['height']} cm high"
        else:
            rows = ", ".join(f"{n}/{d} shaded" for n, d in scene["rows"])
            drawing = f"fraction bars from top to bottom: {rows}"
        selected = self.point or "none"
        grounding = ""
        if self.point and scene["kind"] == "bars":
            row, cell = (int(n) for n in self.point[1:].split("c"))
            n, d = scene["rows"][row - 1]
            selected += f" (row {row}, cell {cell} of {d}, {'shaded' if cell <= n else 'unshaded'})"
            grounding = (
                f"They already pointed. Start your explanation with cell {cell} of row {row}. "
                f"The first {n} of its {d} equal cells are shaded. Use that to explain their cell."
            )
        if self.point and scene["kind"] == "rectangle":
            side = "width" if self.point in ("top", "bottom") else "height"
            selected += f" side ({scene[side]} cm)"
            grounding = (
                f"They already pointed. Start your explanation with the {self.point} side. "
                f"It has the same length as the opposite {OPPOSITE[self.point]} side."
            )
        return (
            f"Visible board: {drawing}. Tutor mark: {scene.get('mark', 'none')}. "
            f"Learner selected: {selected}. {grounding if explain else ''}"
        ).rstrip()

    def reference_reply(self, question: str, language: str, *, identify_only: bool) -> str:
        if not self.point or not self.scene:
            return ""
        words = " ".join(re.findall(r"[a-z0-9]+", plain(question)))
        if not REFERENCE.fullmatch(words):
            return ""
        if self.scene["kind"] == "rectangle":
            other = OPPOSITE[self.point]
            if language == "en":
                line = f"You pointed to the {self.point} side."
                why = f"It is as long as the opposite {other} side."
            else:
                line = f"Señalaste el lado {SIDES_ES[self.point]}."
                why = f"Mide lo mismo que el lado opuesto, el {SIDES_ES[other]}."
        else:
            row, cell = (int(n) for n in self.point[1:].split("c"))
            shaded = self.scene["rows"][row - 1][0]
            if language == "en":
                line = f"You pointed to part {cell} of bar {row}, counting from the left."
                where = "inside" if cell <= shaded else "outside"
                why = f"The shading ends at part {shaded}, so yours is {where} the shaded group."
                if not shaded:
                    why = "The entire bar is unshaded."
            else:
                line = f"Señalaste la parte {cell} de la barra {row}, contando desde la izquierda."
                where = "dentro" if cell <= shaded else "fuera"
                why = f"El sombreado llega hasta la parte {shaded} y la tuya queda {where}."
                if not shaded:
                    why = "La barra entera está sin pintar."
        return line if identify_only else f"{line} {why}"

    def advance(self, step: object) -> dict:
        if not isinstance(step, dict) or not validator("step").is_valid(step):
            raise ValueError("Use an action with its required numbers or the visible part to mark.")
        action = step["action"]
        if action == "start_rectangle":
            return {"kind": "rectangle", "width": step["width"], "height": step["height"]}
        if action == "mark":
            if not has_part(self.scene, step["part"]):
                raise ValueError("That part is not on the visible board.")
            return {**self.scene, "mark": step["part"]}
        n, d = step["numerator"], step["denominator"]
        if n > d:
            raise ValueError("A bar needs between zero and one whole shaded.")
        if action == "start_bars":
            return {"kind": "bars", "rows": [[n, d]]}
        if not self.scene or self.scene["kind"] != "bars" or len(self.scene["rows"]) >= 4:
            raise ValueError("Add a bar to a visible set with room for another row.")
        return {**self.scene, "rows": [*self.scene["rows"], [n, d]]}

    def from_visual(self, visual: dict) -> dict | None:
        """Project a familiar show call onto the next single change the learner can see."""
        if visual.get("kind") == "rectangle" and visual.get("unit") == "cm":
            dimensions = (visual["width"], visual["height"])
            if not all(isinstance(n, int) and 1 <= n <= 50 for n in dimensions):
                return None
            if (
                self.scene
                and self.scene["kind"] == "rectangle"
                and dimensions == (self.scene["width"], self.scene["height"])
            ):
                return {}
            return {
                "action": "start_rectangle",
                "width": visual["width"],
                "height": visual["height"],
            }
        if visual.get("kind") != "fraction_bars":
            return None
        rows = [[f["numerator"], f["denominator"]] for f in visual["fractions"]]
        current = self.scene["rows"] if self.scene and self.scene["kind"] == "bars" else []
        if rows == current[: len(rows)]:
            return {}
        next_index = len(current) if current and rows[: len(current)] == current else 0
        n, d = rows[next_index]
        if n > d or d > 12:
            return None
        return {"action": "add_bar" if current else "start_bars", "numerator": n, "denominator": d}


async def exchange(call: Exchange, message: dict) -> dict:
    """A missing/older screen, disconnection or lost acknowledgement leaves the voice usable."""
    try:
        raw = await call(message)
        if len(raw) <= 2048:
            response = json.loads(raw)
            if isinstance(response, dict):
                return response
    except Exception:
        # RPC errors can contain remote-provided text. Never log them or send them to the model.
        pass
    return {}
