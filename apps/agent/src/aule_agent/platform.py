"""The agent's side of the platform: where the tutor gets what it should know
about the student, and where it reports what was said and what a safety gate
stopped.

Nothing here is allowed to slow the conversation down. The plan is fetched
once, before the greeting, with a short deadline. After that every call runs
in the background: a turn is reported after it happened, and guidance from the
supervisor is applied to the tutor's next turns whenever it arrives. If the
platform is unreachable the tutor keeps working without it.
"""

import asyncio
import json
import logging
import os
import time
from collections.abc import Awaitable, Callable, Mapping
from dataclasses import dataclass, replace
from typing import Any

import aiohttp

from ._version import __version__
from .config import build_commit
from .homework import Reading
from .safety import FLAG_ACTIONS, FLAG_CATEGORIES, FLAG_GATES
from .script import Reply, reply_from
from .tutor import OpenExercise, Persona, persona_from

logger = logging.getLogger("aule.agent.platform")

START_TIMEOUT_SECONDS = 6.0
# One more try when the first call fails, which covers a platform restarting.
START_RETRY_SECONDS = 1.0
# An exercise is checked while the student waits for the tutor's reply.
CHECK_TIMEOUT_SECONDS = 1.5
# What a photo of the homework showed is told while the student waits too,
# after «Veamos.» and the read.
HOMEWORK_TIMEOUT_SECONDS = 3.0
REPORT_TIMEOUT_SECONDS = 10.0
REPORT_RETRY_SECONDS = 1.0
END_FLUSH_TIMEOUT_SECONDS = 5.0
# The platform accepts at most 20 turns per request.
MAX_TURNS_PER_REPORT = 20
# Turns kept while the platform is unreachable; older ones are dropped.
MAX_PENDING_TURNS = 50
ROLES = {"user": "child", "assistant": "tutor"}
# What the platform may ask when a student is not working.
STOPS = ("warn", "end")
# The longest name the platform accepts for a student.
MAX_NAME_CHARS = 40
# One flag per gate, action and gravest category in this time, so a topic a
# child keeps returning to does not flood the reports.
FLAG_COOLDOWN_SECONDS = 300.0
FLAG_TIMEOUT_SECONDS = 2.0
MAX_FLAGS_IN_FLIGHT = 4

# What the platform answers, on the calls that speak for the whole session,
# when the session is over for it: it has ended, or the agent's token is no
# longer good. The same statuses elsewhere say something about that one call
# (an exercise the engine owns, for one), and 404 can be an older platform.
SESSION_OVER = frozenset({401, 403, 409, 410})

Send = Callable[[str, str, dict[str, Any] | None, float], Awaitable[dict[str, Any] | None]]


class Refused(Exception):
    """The platform answered, and the answer was no."""

    def __init__(self, status: int) -> None:
        super().__init__(f"platform answered {status}")
        self.status = status


@dataclass(frozen=True)
class PlatformSession:
    url: str
    token: str


def user_agent(commit: str) -> str:
    """What the agent calls itself on every request to the platform, as
    Anthropic's SDKs do: its version and the start of its commit."""
    return f"aule-agent/{__version__} (+{commit[:7]})"


def platform_session(
    dispatch_metadata: str, env: Mapping[str, str] | None = None
) -> PlatformSession | None:
    """The platform session this job belongs to, if it was created by one."""
    env = os.environ if env is None else env
    url = env.get("AULE_PLATFORM_URL", "").strip().rstrip("/")
    try:
        metadata = json.loads(dispatch_metadata or "{}")
    except ValueError:
        return None
    token = metadata.get("platform_token") if isinstance(metadata, dict) else None
    if not url or not isinstance(token, str) or not token:
        return None
    return PlatformSession(url=url, token=token)


def _said(answer: dict[str, Any] | None) -> str | None:
    say = (answer or {}).get("say")
    return say if isinstance(say, str) and say else None


class Platform:
    def __init__(
        self,
        session: PlatformSession,
        send: Send | None = None,
        clock: Callable[[], float] = time.monotonic,
        *,
        homework_capability: int = 0,
    ) -> None:
        self._session = session
        self._send = send or self._http
        # What the agent can do with the student's homework, said when the
        # session starts: 1 reads its level from a photo. The platform caps
        # it, and an engine told nothing asks for no photo.
        self._homework_capability = homework_capability
        # Which build of the agent makes each call, for the platform's side of a problem.
        self._user_agent = user_agent(build_commit())
        # Filled by ``start`` from the agent-session body; the tutor's persona.
        self.persona: Persona | None = None
        # For the greeting: what to call the student and which of their
        # sessions this is; the physical-safety gate gets the name only to
        # leave it out of what it sends. Never logged, never stored by the agent.
        self.student_name: str | None = None
        self.session_number: int | None = None
        # For the physical-safety gate only: the student's age, from their
        # year of birth, and their school grade. Never logged; the gate decides
        # which of them it passes on.
        self.student_age: int | None = None
        self.student_grade: str | None = None
        # Filled by ``start`` when the session engine runs this session: what
        # it wrote for the tutor to open with.
        self._opening = Reply()
        self._scripted = False
        # What the engine wrote for something that reached it another way (an
        # answer typed on the page), until the tutor says it.
        self._written: list[Reply] = []
        self._clock = clock
        self._flagged_at: dict[tuple[str, str, str], float] = {}
        self._flags: set[asyncio.Task[None]] = set()
        self._http_session: aiohttp.ClientSession | None = None
        self._pending: list[dict[str, Any]] = []
        self._next_seq = 0
        self._after_guidance = 0
        self._wake = asyncio.Event()
        # The plan, when the platform sends it after the session began; and
        # whether the tutor already has it.
        self._late_plan: str | None = None
        self._plan_given = False
        # What the platform asks about a student who is not working: nothing,
        # a warning, or the end. The end stands once asked for.
        self._stop: str | None = None
        self._stops_done: set[str] = set()
        # Why the session ended, when it was not the clock or the person leaving.
        self.end_reason: str | None = None
        # The platform no longer serves this session. Nothing more is sent to
        # it, and the session has nobody to work for. An unreachable platform
        # is not this: the tutor carries on without it.
        self.gone = False
        # The platform decides when a break is due and repeats its offer until
        # it reads here that one was taken.
        self._pause = False
        self.breaks_taken = 0
        # The exercise the platform has open for the tutor, as it last said: a
        # pose opens it, and an answer that closes it, or finds none open,
        # clears it. An answer that asks for a worked example sets it aside,
        # until it is posed again. A call that failed leaves it as it was.
        self.exercise: OpenExercise | None = None

    async def _http(
        self, method: str, path: str, body: dict[str, Any] | None, timeout: float
    ) -> dict[str, Any] | None:
        if self._http_session is None:
            self._http_session = aiohttp.ClientSession()
        async with self._http_session.request(
            method,
            f"{self._session.url}{path}",
            json=body,
            headers={
                "Authorization": f"Bearer {self._session.token}",
                "User-Agent": self._user_agent,
            },
            timeout=aiohttp.ClientTimeout(total=timeout),
            allow_redirects=False,
        ) as response:
            if response.status == 204:
                return {}
            if response.status not in (200, 201):
                # The body may repeat what was sent, so only the status is kept.
                raise Refused(response.status)
            return await response.json()

    async def _call(
        self,
        method: str,
        path: str,
        body: dict[str, Any] | None,
        timeout: float,
        *,
        for_the_session: bool = False,
        refused: Callable[[int], None] | None = None,
    ) -> dict[str, Any] | None:
        """One call. None when it failed. ``for_the_session`` marks the calls
        whose refusal means the session itself is over for the platform;
        ``refused`` is told the status of a refusal of this one call."""
        if self.gone:
            return None
        try:
            return await self._send(method, path, body, timeout)
        except asyncio.CancelledError:
            raise
        except Exception as error:  # the tutor never stops because of the platform
            status = error.status if isinstance(error, Refused) else None
            logger.warning(
                "platform call failed",
                extra={"path": path, "error": type(error).__name__, "status": status},
            )
            if for_the_session and status in SESSION_OVER:
                self.gone = True
                # Nothing kept for later: there is nobody to send it to.
                self._pending.clear()
                logger.warning("the platform no longer serves this session")
            if refused is not None and status is not None:
                refused(status)
            return None

    async def start(self) -> str:
        """What the tutor should know before it says hello. Empty if unknown."""
        answer = await self._ask_to_start()
        if answer is None and not self.gone:
            await asyncio.sleep(START_RETRY_SECONDS)
            answer = await self._ask_to_start()
        answer = answer or {}
        tutor = answer.get("tutor")
        if isinstance(tutor, dict):
            self.persona = persona_from(tutor.get("name"), tutor.get("persona"), tutor.get("note"))
        name = answer.get("student_name")
        if isinstance(name, str) and 0 < len(name.strip()) <= MAX_NAME_CHARS:
            self.student_name = name.strip()
        number = answer.get("session_number")
        if type(number) is int and number >= 0:
            self.session_number = number
        age = answer.get("student_age")
        if type(age) is int:
            self.student_age = age
        grade = answer.get("student_grade")
        if isinstance(grade, str):
            self.student_grade = grade
        script = answer.get("script")
        if isinstance(script, dict):
            self._scripted = True
            self._opening = reply_from(script) or Reply()
        instructions = answer.get("instructions")
        return instructions if isinstance(instructions, str) else ""

    def _ask_to_start(self) -> Awaitable[dict[str, Any] | None]:
        # A platform that does not know the question ignores it.
        capability = self._homework_capability
        path = "/v1/agent/session" + (f"?homework={capability}" if capability else "")
        return self._call("GET", path, None, START_TIMEOUT_SECONDS, for_the_session=True)

    @property
    def scripted(self) -> bool:
        """Whether the session engine runs this session."""
        return self._scripted

    def opening(self) -> Reply:
        return self._opening

    async def said(self, text: str) -> Reply | None:
        """Hands what the student said to the engine and returns what it wrote
        back. None when it has nothing to say or could not be reached: the
        model answers then, as in a session without an engine."""
        answer = await self._call(
            "POST", "/v1/agent/session/said", {"said": text}, CHECK_TIMEOUT_SECONDS
        )
        return reply_from(answer)

    async def homework(self, report: Reading) -> Reply | None:
        """Tells the engine what a photo of the homework showed and returns
        what it wrote back, an empty reply when it had nothing to say. None
        when it could not be told: the student is asked to show it again.
        Never the photo, and the level and the confidence only for a read.
        A refusal is about this one report, never the end of the session."""
        body: dict[str, Any] = {"outcome": report.outcome}
        if report.outcome == "read":
            body["level"] = report.level
            body["confidence"] = report.confidence
        answer = await self._call(
            "POST", "/v1/agent/session/homework", body, HOMEWORK_TIMEOUT_SECONDS
        )
        if answer is None:
            return None
        return reply_from(answer) or Reply()

    async def pose(self, expression: str, skill_id: str | None, form: str | None) -> str | None:
        """Tells the platform which exercise is being asked. Returns what the
        tutor should do, or None when the platform cannot check this one."""
        body = {"expression": expression}
        if skill_id:
            body["skill_id"] = skill_id
        if form:
            body["form"] = form
        answer = await self._call(
            "POST", "/v1/agent/session/exercises", body, CHECK_TIMEOUT_SECONDS
        )
        posed = (answer or {}).get("exercise")
        if type(posed) is int and (self.exercise is None or self.exercise.id != posed):
            self.exercise = OpenExercise(id=posed, expression=expression.strip())
        elif type(posed) is int and self.exercise is not None:
            # The same exercise stated again keeps its id, and how it was first
            # written; the tutor is back on it.
            self.exercise = replace(self.exercise, aside=False)
        return _said(answer)

    async def answer(self, said: str) -> str | None:
        """Has the platform judge the student's answer to the open exercise.
        Returns what the tutor should do, or None when it could not be judged."""
        answer = await self._call(
            "POST",
            "/v1/agent/session/answers",
            {"said": said},
            CHECK_TIMEOUT_SECONDS,
            refused=self._none_open,
        )
        if (answer or {}).get("closed") is True:
            self.exercise = None
        elif (answer or {}).get("next") == "worked_example" and self.exercise is not None:
            # The tutor works a similar one with other numbers first: what the
            # student says meanwhile answers that one, not theirs.
            self.exercise = replace(self.exercise, aside=True)
        say = _said(answer)
        reveal = (answer or {}).get("reveal")
        if say and isinstance(reveal, str) and reveal:
            # Only sent once the exercise is closed, to work it out together.
            return f"{say} The answer is {reveal}."
        return say

    def _none_open(self, status: int) -> None:
        # 409 to an answer: nothing is open, or what is open cannot be checked.
        if status == 409:
            self.exercise = None

    def wake(self) -> None:
        """Reports now, with or without a turn to send: the platform has
        something waiting for the tutor."""
        self._wake.set()

    def heard(self, role: str, text: str | None) -> None:
        """Queues one finished turn. Never waits."""
        text = (text or "").strip()
        if role not in ROLES or not text or self.gone:
            return
        self._pending.append({"seq": self._next_seq, "role": ROLES[role], "content": text})
        self._next_seq += 1
        del self._pending[:-MAX_PENDING_TURNS]
        self._wake.set()

    def flag(self, gate: str, action: str, categories: list[str]) -> None:
        """Queues the report of a turn a safety gate stopped. Never waits, never raises.

        Only the fixed vocabulary of ``safety`` is sent; anything else is a bug
        in the caller and is dropped rather than forwarded.
        """
        categories = list(dict.fromkeys(categories))
        if (
            gate not in FLAG_GATES
            or action not in FLAG_ACTIONS
            or not categories
            or any(category not in FLAG_CATEGORIES for category in categories)
        ):
            logger.error("flag dropped: outside the fixed vocabulary")
            return
        key = (gate, action, categories[0])
        last = self._flagged_at.get(key)
        cooling = last is not None and self._clock() - last < FLAG_COOLDOWN_SECONDS
        if cooling or len(self._flags) >= MAX_FLAGS_IN_FLIGHT:
            return
        self._flagged_at[key] = self._clock()
        task = asyncio.create_task(self._send_flag(key, categories))
        self._flags.add(task)
        task.add_done_callback(self._flags.discard)

    async def _send_flag(self, key: tuple[str, str, str], categories: list[str]) -> None:
        answer = await self._call(
            "POST",
            "/v1/agent/session/flags",
            {"gate": key[0], "action": key[1], "categories": categories},
            FLAG_TIMEOUT_SECONDS,
        )
        if answer is None:
            # A flag that did not arrive does not use up the cooldown.
            self._flagged_at.pop(key, None)

    async def report_once(self) -> str | None:
        """Sends a snapshot in bounded batches and returns the newest guidance."""
        turns = list(self._pending)
        batches = [
            turns[start : start + MAX_TURNS_PER_REPORT]
            for start in range(0, len(turns), MAX_TURNS_PER_REPORT)
        ] or [[]]
        newest = None
        for batch in batches:
            answer = await self._call(
                "POST",
                "/v1/agent/session/turns",
                {
                    "turns": batch,
                    "after_guidance": self._after_guidance,
                    "breaks_taken": self.breaks_taken,
                },
                REPORT_TIMEOUT_SECONDS,
                for_the_session=True,
            )
            if answer is None:
                break
            # Keep unacknowledged turns in the queue, including if this task is
            # cancelled during the request. New arrivals have larger seq values.
            if batch:
                self._pending = [turn for turn in self._pending if turn["seq"] > batch[-1]["seq"]]
            stop = answer.get("stop")
            if stop in STOPS and self._stop != "end":
                self._stop = stop
            self._pause = answer.get("pause") == "offer"
            written = reply_from(answer.get("script"))
            if written is not None:
                self._written.append(written)
            plan = answer.get("plan")
            if isinstance(plan, str) and plan.strip() and self._late_plan is None:
                self._late_plan = plan
            for item in answer.get("guidance") or []:
                if isinstance(item.get("id"), int) and isinstance(item.get("instructions"), str):
                    self._after_guidance = max(self._after_guidance, item["id"])
                    newest = item["instructions"]
        return newest

    async def run(
        self,
        advise: Callable[[str], Awaitable[None]],
        plan: Callable[[str], Awaitable[None]] | None = None,
        stop: Callable[[str], Awaitable[None]] | None = None,
        gone: Callable[[], Awaitable[None]] | None = None,
        pause: Callable[[], Awaitable[None]] | None = None,
        written: Callable[[Reply], Awaitable[None]] | None = None,
    ) -> None:
        """Reports turns as they come and hands the plan, once, and guidance to
        the tutor; a warning or the end, once each, when the platform asks for
        it; and a break each time it offers one. Runs until cancelled, or until
        the platform refuses the session: then it says so, once, and stops."""
        while True:
            await self._wake.wait()
            self._wake.clear()
            guidance = await self.report_once()
            if self.gone:
                if gone:
                    await gone()
                return
            if plan and self._late_plan and not self._plan_given:
                # Before the guidance of the same answer, which builds on it.
                self._plan_given = True
                await plan(self._late_plan)
            if guidance:
                await advise(guidance)
            if stop and self._stop and self._stop not in self._stops_done:
                self._stops_done.add(self._stop)
                await stop(self._stop)
            if pause and self._pause:
                self._pause = False
                await pause()
            while written and self._written:
                await written(self._written.pop(0))
            if self._pending:
                await asyncio.sleep(REPORT_RETRY_SECONDS)
                self._wake.set()

    async def end(self, measures: Mapping[str, float] | None = None) -> None:
        """Reports what is left and closes the session, with the agent's own
        numbers about it (how long it lasted, what the model used)."""
        if self.gone:
            # Refused already: nothing to flush and nobody to tell.
            for task in self._flags:
                task.cancel()
            await asyncio.gather(*self._flags, return_exceptions=True)
            await self._close()
            return
        if self._flags:
            # Flags are best effort; the end of a session does not wait long for them.
            _, late = await asyncio.wait(self._flags, timeout=FLAG_TIMEOUT_SECONDS)
            for task in late:
                task.cancel()
            await asyncio.gather(*late, return_exceptions=True)
        try:
            async with asyncio.timeout(END_FLUSH_TIMEOUT_SECONDS):
                while self._pending:
                    await self.report_once()
                    if self._pending:
                        await asyncio.sleep(REPORT_RETRY_SECONDS)
        except TimeoutError:
            logger.warning(
                "session ended with unreported turns", extra={"turns": len(self._pending)}
            )
        body: dict[str, Any] = {"end_reason": "error"} if self._pending else {}
        if self.end_reason and not self._pending:
            body = {"end_reason": self.end_reason}
        if measures:
            body["metrics"] = dict(measures)
        await self._call("POST", "/v1/agent/session/end", body, REPORT_TIMEOUT_SECONDS)
        await self._close()

    async def _close(self) -> None:
        if self._http_session is not None:
            await self._http_session.close()
