"""What the session engine wrote for the tutor to say.

The engine decides a session: the question to ask, the hint that is due, what
to say when an answer is right or wrong, when to stop. Its words were written
and read by people, so they are said as they are: no model writes them, no
model is asked. The model only speaks when the student leaves the script, to
ask something or to talk.
"""

from dataclasses import dataclass
from typing import Any, Literal, Protocol

from . import choices, visuals
from .homework import Reading

# The longest line that is said. A line of the script is a sentence or two.
MAX_LINE_CHARS = 1200
# One answer can carry a worked example step by step and the next question
# after it; the cap is there for an answer gone wrong, not for a long one.
MAX_LINES = 24

# What the engine may be waiting for: a photo of the homework, or the homework
# itself, worked through with the student one exercise at a time.
Awaits = Literal["homework_photo", "homework"]
AWAITS: tuple[Awaits, ...] = ("homework_photo", "homework")


@dataclass(frozen=True)
class Line:
    """One thing the tutor says, and what goes on the screen with it."""

    say: str
    show: dict[str, Any] | None = None
    # The line may repeat the student's own words. Those are not the engine's,
    # so it is judged before it is said, like anything a model writes.
    echoes: bool = False
    # What the student can tap under it once it has been said (``choices``):
    # the engine's own words, as its lines are.
    choices: dict[str, Any] | None = None


@dataclass(frozen=True)
class Reply:
    """The engine's answer to what the student said.

    ``lines`` are said as written. With ``converse`` the model then answers the
    student within those rules (the student asked something); without it the
    turn is over and the model is not called.
    """

    lines: tuple[Line, ...] = ()
    converse: str | None = None
    # The engine ended the session: after these lines nothing follows.
    closed: bool = False
    # What the engine waits for now; None for nothing in particular.
    awaits: Awaits | None = None
    # The engine's own activity is over while the room stays open: its rules
    # then ask the model for a goodbye, which is said (``closing``).
    over: bool = False


class Engine(Protocol):
    """The engine, as the tutor sees it: the platform."""

    def opening(self) -> Reply: ...

    async def said(self, text: str) -> Reply | None: ...

    async def homework(self, report: Reading) -> Reply | None: ...


def lines_from(value: object) -> tuple[Line, ...]:
    """The lines in something the platform sent. Anything malformed is left out:
    a broken line is never said and never stops the others."""
    if not isinstance(value, list):
        return ()
    lines = []
    for item in value[:MAX_LINES]:
        if not isinstance(item, dict):
            continue
        say = item.get("say")
        if not isinstance(say, str) or not say.strip() or len(say) > MAX_LINE_CHARS:
            continue
        show = item.get("show")
        drawable = isinstance(show, dict) and not visuals.problems(show)
        offered = item.get("choices")
        tappable = isinstance(offered, dict) and not choices.problems(offered)
        lines.append(
            Line(
                say=say.strip(),
                show=show if drawable else None,
                # Anything but a plain "no" is taken as "it may".
                echoes=item.get("echoes") is not False,
                choices=offered if tappable else None,
            )
        )
    return tuple(lines)


def reply_from(value: object) -> Reply | None:
    """The reply in the platform's answer, or None when it has nothing to say
    and the turn is the model's. What the engine waits for comes with what
    it says; anything but a value it is known to wait for is nothing."""
    if not isinstance(value, dict):
        return None
    lines = lines_from(value.get("lines"))
    converse = value.get("converse")
    rules = converse.strip() if isinstance(converse, str) and converse.strip() else None
    closed = value.get("closed") is True
    if not lines and rules is None and not closed:
        return None
    awaits = next((known for known in AWAITS if value.get("awaits") == known), None)
    over = value.get("over") is True
    return Reply(lines=lines, converse=rules, closed=closed, awaits=awaits, over=over)
