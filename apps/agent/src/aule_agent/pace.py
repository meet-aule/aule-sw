"""The pace of a session: its breaks, the warning before the end, the goodbye,
and closing it when the student has gone.

No model writes any of it. The lines are the reviewed ones in ``replies``, and
each is said in a quiet moment: once the tutor has finished its reply and while
the student is not talking, never over either of them.
"""

import asyncio
import itertools
import logging
import re
import time
import unicodedata
from collections.abc import Awaitable, Callable
from typing import Any

from .replies import BREAKS, RESTS, reply

logger = logging.getLogger("aule.agent.pace")

# The end is announced this long before it. A session too short for that hears
# it later, and one shorter than the later warning hears only the goodbye.
WARNING_MINUTES = 5
SHORT_SESSION_MINUTES = 10
SHORT_WARNING_MINUTES = 2
# How long a quiet moment is waited for. After that the line is said anyway;
# the voice still puts it behind whatever is being said.
QUIET_TIMEOUT_SECONDS = 30.0
QUIET_POLL_SECONDS = 0.25
# The platform repeats its offer of a break until it hears that one was taken.
# Nothing is offered while a break is on, nor this soon after one.
BREAK_COOLDOWN_SECONDS = 300.0
# A student who says nothing for this long is asked whether they are still
# there, and the session closes if they still say nothing. Long enough for an
# exercise worked out in a notebook; silence while the tutor talks or during a
# break does not count.
IDLE_ASK_SECONDS = 180.0
IDLE_CLOSE_SECONDS = 60.0
IDLE_POLL_SECONDS = 5.0

# What says the student is tired or sleepy, in their words without accents:
# "estoy cansada", "ya me cansé", "tengo sueño", "I'm so tired". A dream ("tuve
# un sueño") is not sleepiness, and boredom is not tiredness: a break that
# wakes them up suits it.
_TIRED = re.compile(
    r"\b(cans[aeio]\w*|descans\w*|agotad[oa]s?|no puedo mas|"
    r"(tengo|da|dio|de|con|que|mucho|muchisimo) sueno|(quiero|ganas de) dormir|"
    r"tired|sleepy|exhausted|worn out|(want|wanna) (to )?sleep)\b"
)


def warning(max_minutes: int) -> tuple[int, str] | None:
    """How many minutes before the end the warning is said, and its line."""
    if max_minutes >= SHORT_SESSION_MINUTES:
        return WARNING_MINUTES, "five_minutes_left"
    if max_minutes > SHORT_WARNING_MINUTES:
        return SHORT_WARNING_MINUTES, "two_minutes_left"
    return None


def says_tired(text: str) -> bool:
    """Whether the student says they are tired or sleepy. Their words are read
    for this alone and kept nowhere; a wrong yes only makes the next break a
    calm one."""
    unaccented = unicodedata.normalize("NFKD", text.lower())
    plain = "".join(c for c in unaccented if not unicodedata.combining(c))
    return _TIRED.search(plain) is not None


class Pace:
    def __init__(
        self,
        session: Any,
        language: str,
        *,
        max_minutes: int,
        break_minutes: int,
        taken: Callable[[int], None] | None = None,
        clock: Callable[[], float] = time.monotonic,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
    ) -> None:
        self._session = session
        self._language = language
        self._max_seconds = max_minutes * 60.0
        self._warning = warning(max_minutes)
        self._break_seconds = break_minutes * 60.0
        self._taken = taken
        self._clock = clock
        self._sleep = sleep
        self._started = clock()
        self.breaks_taken = 0
        # The activities offered in turn, and whether the student said they
        # are tired since the last break: then the next one is a calm one.
        self._breaks = itertools.cycle(BREAKS)
        self._rests = itertools.cycle(RESTS)
        self._tired = False
        self._offering = False
        self._on_break = False
        self._break_ended: float | None = None
        self._resume: asyncio.Task[None] | None = None
        self._heard_at = self._started
        self._asked_if_there = False
        self.closed_for_time = False
        self.closed_for_inactivity = False
        self.closed_after_goodbye = False

    def minutes(self) -> float:
        """How long the session has lasted."""
        return (self._clock() - self._started) / 60.0

    async def run(self) -> None:
        """Says that the end is near, then the goodbye, and closes the session."""
        if self._warning is not None:
            before, line = self._warning
            await self._sleep(self._max_seconds - before * 60.0)
            # It joins the conversation: the tutor knows there is little time left.
            await self._say(line, remembered=True)
        await self._sleep(max(0.0, self._max_seconds - (self._clock() - self._started)))
        self.closed_for_time = True
        await self._say("goodbye", remembered=False)
        self._session.shutdown()

    async def farewell(self) -> None:
        """The student said goodbye: the tutor says it back and the session closes."""
        if self.closed_after_goodbye:
            return
        self.closed_after_goodbye = True
        logger.info("closed after a goodbye", extra={"minutes": round(self.minutes(), 1)})
        await self._say("farewell", remembered=False)
        self._session.shutdown()

    async def take_a_break(self) -> None:
        """Proposes one short activity away from the work and lets the student go.

        A student who said they are tired is invited to rest, which they may
        turn down by carrying on; any other break wakes them up or calms them,
        in turn. The tutor says nothing more until the student talks again or
        the break is over, whichever comes first. Asked for again while a
        break is on or just after one, it does nothing.
        """
        recent = (
            self._break_ended is not None
            and self._clock() - self._break_ended < BREAK_COOLDOWN_SECONDS
        )
        if self._offering or self._on_break or recent:
            return
        self._offering = True
        try:
            line = next(self._rests if self._tired else self._breaks)
            self._tired = False
            self.breaks_taken += 1
            number = self.breaks_taken
            self._on_break = True
            if self._taken is not None:
                self._taken(number)
            await self._say(line, remembered=True)
            # Counts only: what is said in a session is never logged.
            logger.info("break offered", extra={"breaks": number})
            if self._on_break:
                self._resume = asyncio.create_task(self._ask_to_go_on(number))
        finally:
            self._offering = False

    async def watch(self) -> None:
        """Asks a silent student whether they are still there, and closes the
        session with a goodbye when they do not answer."""
        while True:
            await self._sleep(IDLE_POLL_SECONDS)
            now = self._clock()
            # The student is not expected to talk while the tutor does, or on a break.
            tutor_busy = self._session.agent_state in ("thinking", "speaking")
            if self._on_break or self._offering or tutor_busy:
                self._heard_at = now
                continue
            silent = now - self._heard_at
            if not self._asked_if_there and silent >= IDLE_ASK_SECONDS:
                self._asked_if_there = True
                await self._say("still_there", remembered=True)
                self._heard_at = self._clock()
            elif self._asked_if_there and silent >= IDLE_CLOSE_SECONDS:
                self.closed_for_inactivity = True
                logger.info("closed for inactivity", extra={"minutes": round(self.minutes(), 1)})
                await self._say("idle_goodbye", remembered=False)
                self._session.shutdown()
                return

    def student_is_there(self) -> None:
        """The student finished a turn, whatever became of it: they are there.

        Not every turn joins the conversation, which is where ``student_spoke``
        is heard from: one the engine answers is kept another way, and one a
        gate stops is kept nowhere. Counted as silence, such turns closed a
        session on a student who was talking, and who had answered «¿Sigues
        ahí?» (2026-11-27: 48 things heard, 8 of them turns that counted).
        Nothing else follows from them here: a break still ends only with a
        turn the gates let through.
        """
        self._heard_at = self._clock()
        self._asked_if_there = False

    def student_spoke(self, *, tired: bool = False) -> None:
        """The student said or wrote something: they are there, and back from
        a break. ``tired`` when it said they are tired (``says_tired``)."""
        self.student_is_there()
        self._tired = self._tired or tired
        if not self._on_break:
            return
        self._on_break = False
        self._break_ended = self._clock()
        if self._resume is not None:
            self._resume.cancel()
            self._resume = None

    def close(self) -> None:
        if self._resume is not None:
            self._resume.cancel()

    async def _ask_to_go_on(self, number: int) -> None:
        await self._sleep(self._break_seconds)
        if not self._on_break or self.breaks_taken != number:
            return
        self._on_break = False
        self._break_ended = self._clock()
        self._resume = None
        await self._say("break_over", remembered=True, interruptible=True)

    async def _say(self, line: str, *, remembered: bool, interruptible: bool = False) -> None:
        await self._quiet()
        await self._session.say(
            reply(line, self._language),
            add_to_chat_ctx=remembered,
            allow_interruptions=interruptible,
        )

    async def _quiet(self) -> None:
        """Waits until the tutor owes no reply and the student is not talking."""
        waited = 0.0
        while waited < QUIET_TIMEOUT_SECONDS:
            if (
                self._session.agent_state in ("listening", "idle")
                and self._session.user_state != "speaking"
            ):
                return
            await self._sleep(QUIET_POLL_SECONDS)
            waited += QUIET_POLL_SECONDS
