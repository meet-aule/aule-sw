"""Exact comparisons for hints, without changing the open exercise or its answer."""

import json
import re
from fractions import Fraction
from typing import Any

# Literals only, with bounded size: no expressions, code, exponents or floats.
_NUMBER = re.compile(r"[+-]?[0-9]{1,18}(?:/[+-]?[0-9]{1,18}|\.[0-9]{1,18})?")
MAX_CHARS = 40

SCHEMA: dict[str, Any] = {
    "name": "compare_numbers",
    "description": (
        "Before asserting that one number is smaller, equal or larger than another, "
        "compare them exactly. Use integer, fraction or decimal strings, e.g. '2/29', '1/15', "
        "'-3', '0.25'; not expressions or words. Compare against each number separately "
        "when claiming 'smaller than both'. This does not change the open exercise."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "left": {"type": "string", "maxLength": MAX_CHARS},
            "right": {"type": "string", "maxLength": MAX_CHARS},
        },
        "required": ["left", "right"],
        "additionalProperties": False,
    },
}


def _number(value: object) -> Fraction | None:
    if not isinstance(value, str) or len(value) > MAX_CHARS:
        return None
    value = value.strip()
    if _NUMBER.fullmatch(value) is None:
        return None
    try:
        if "/" in value:
            numerator, denominator = value.split("/", 1)
            return Fraction(int(numerator), int(denominator))
        return Fraction(value)
    except (ValueError, ZeroDivisionError):
        return None


def compare(left: object, right: object) -> str:
    """Only a successfully parsed pair gets a relation. Never guesses or logs input."""
    a, b = _number(left), _number(right)
    if a is None or b is None:
        return json.dumps(
            {
                "verified": False,
                "instruction": "Unverified. Supply supported number literals before comparing.",
            }
        )
    relation = "less_than" if a < b else "greater_than" if a > b else "equal"
    return json.dumps({"verified": True, "left": str(a), "relation": relation, "right": str(b)})
