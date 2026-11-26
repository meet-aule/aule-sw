"""A tutor whose model fails is never silent, proved on whole sessions: the
real worker, session, tutor and gates, every provider stood in for
(``fakes``) and the child scripted (``latency_harness``). The model refuses
a request or never answers it, as the real API can; no request leaves the
machine.

1. A model that can no longer answer (no credit left, as on 2026-11-25) ends
   the session at once with a fixed line, and the platform is told why.
2. A request that never answers gets a fixed line once the step's time is up
   and is asked once more; a model that keeps failing ends the session.
3. Nothing the output gate did not approve is heard, and no log carries the
   child's words or what the provider wrote.
"""

import asyncio
import json
import logging
from collections.abc import Iterator
from dataclasses import dataclass
from typing import Any

import latency_harness as harness
import pytest
from fakes import CHILD_WORDS, NO_CREDIT, Delays, Played, TurnPlan, World, refusal, words_of

from aule_agent import tutor
from aule_agent.replies import REPLIES

FAST = Delays(scale=0.05)
# The step's time in these sessions, instead of the watchdog's fifteen seconds.
STEP_SECONDS = 1.0
END = "/v1/agent/session/end"
REPLY = "Muy bien, cuéntame cómo lo pensaste."
HOLD_ON = REPLIES["hold_on"]["es"]
CLOSING = REPLIES["tutor_unavailable"]["es"]


async def no_credit(request: dict[str, Any]) -> None:
    raise refusal(400, "invalid_request_error", NO_CREDIT)


class Hangs:
    """Requests for a reply that never answer: the first ``first`` of them, or
    all. The warm-up answers. Counts how many hung and how many were closed."""

    def __init__(self, first: int | None = None) -> None:
        self.first = first
        self.hung = 0
        self.closed = 0

    async def __call__(self, request: dict[str, Any]) -> None:
        if request.get("stream") is not True:
            return
        if self.first is not None and self.hung >= self.first:
            return
        self.hung += 1
        try:
            await asyncio.Event().wait()
        finally:
            self.closed += 1


@dataclass
class Run:
    world: World
    results: list[harness.TurnResult]
    lines: list[str]

    def logged(self, message: str) -> list[dict[str, Any]]:
        return [record for line in self.lines if (record := json.loads(line))["message"] == message]

    def end_reason(self) -> str | None:
        (body,) = [body for _, path, body in self.world.platform_calls if path == END]
        return body.get("end_reason")


def run(trouble: Any, turns: int) -> Run:
    """One session whose model has ``trouble``, of ``turns`` turns."""

    async def session() -> Run:
        records = harness.Records()
        root = logging.getLogger()
        level = root.level
        root.addHandler(records)
        root.setLevel(logging.INFO)
        try:
            with harness.offline():
                world = World(seed=11, delays=FAST)
                world.model_trouble = trouble
                planned = []
                for number in range(1, turns + 1):
                    world.plans[words_of(number)] = TurnPlan(reply=REPLY)
                    planned.append(harness.Turn(number, "reply", words_of(number), 0.4, 0.1))
                done = await harness.run_session(world, planned)
        finally:
            root.removeHandler(records)
            root.setLevel(level)
        return Run(done.world, done.results, records.lines)

    return asyncio.run(session())


@pytest.fixture(scope="module")
def step_seconds() -> Iterator[None]:
    saved = tutor.STEP_SECONDS
    tutor.STEP_SECONDS = STEP_SECONDS
    try:
        yield
    finally:
        tutor.STEP_SECONDS = saved


@pytest.fixture(scope="module")
def out_of_credit() -> Run:
    return run(no_credit, turns=1)


@pytest.fixture(scope="module")
def hung_once(step_seconds: None) -> tuple[Run, Hangs]:
    trouble = Hangs(first=1)
    return run(trouble, turns=2), trouble


@pytest.fixture(scope="module")
def always_hung(step_seconds: None) -> tuple[Run, Hangs]:
    trouble = Hangs()
    return run(trouble, turns=1), trouble


def heard(segments: list[Played]) -> str:
    return " ".join(" ".join(text for segment in segments for text in segment.texts).split())


def spoken(*texts: str) -> str:
    return " ".join(" ".join(texts).split())


def test_a_model_out_of_credit_ends_the_session_at_once_with_a_fixed_line(out_of_credit):
    (turn,) = out_of_credit.results

    assert turn.allowed is True
    # Only the closing line: no line that promises a moment, nothing of the model.
    assert heard(turn.played) == spoken(CLOSING)
    assert spoken("".join(turn.shown)) == spoken(CLOSING)
    # Within seconds of the release, after the gates let the turn through.
    assert turn.first_audio is not None and turn.first_audio < 3.0
    assert turn.played[0].started_at >= turn.decided_at
    # The worker closed the session after the line.
    assert out_of_credit.world.session.shutdown_asked
    assert out_of_credit.end_reason() == "provider_error"


def test_a_model_out_of_credit_is_logged_once_with_its_status_and_no_words(out_of_credit):
    (warning,) = out_of_credit.logged("tutor model unavailable")

    assert warning["level"] == "WARNING"
    assert (warning["error"], warning["status"], warning["cause"]) == (
        "APIStatusError",
        400,
        "billing",
    )
    assert not [line for line in out_of_credit.lines if CHILD_WORDS in line]
    assert NO_CREDIT not in json.dumps(warning)


def test_a_request_that_hangs_gets_a_line_once_its_time_is_up_and_is_asked_once_more(
    hung_once,
):
    session, trouble = hung_once
    first, second = session.results

    assert heard(first.played) == spoken(HOLD_ON, REPLY)
    # The line comes once the step's time is up, and only then.
    waited = first.played[0].started_at - first.decided_at
    assert STEP_SECONDS <= waited < STEP_SECONDS + 1.5
    # The request that hung was closed; the reply heard is the one the gate approved.
    assert trouble.hung == trouble.closed == 1
    assert REPLY in session.world.approved and harness.unapproved(session.world) == 0
    # The next turn is answered as usual, and the session goes on.
    assert heard(second.played) == spoken(REPLY)
    assert session.logged("tutor model unavailable") == []
    assert not session.world.session.shutdown_asked
    assert session.end_reason() != "provider_error"


def test_a_model_that_keeps_hanging_ends_the_session_after_the_line(always_hung):
    session, trouble = always_hung
    (turn,) = session.results

    assert heard(turn.played) == spoken(HOLD_ON, CLOSING)
    assert trouble.hung == trouble.closed == 2
    assert session.world.session.shutdown_asked and session.end_reason() == "provider_error"
    (warning,) = session.logged("tutor model unavailable")
    assert (warning["error"], warning["status"], warning["cause"], warning["failures"]) == (
        "NoReplyInTime",
        None,
        "in_a_row",
        2,
    )
    assert not [line for line in session.lines if CHILD_WORDS in line]
