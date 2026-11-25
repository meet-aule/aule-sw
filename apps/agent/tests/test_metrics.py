"""The numbers a session ends with, as the platform keeps them
(apps/platform/src/metrics.rs ``numbers_only``): at most 40, each a finite
number under a name of at most 40 characters of a-z, 0-9 and _. Past 40 the
platform drops names silently, in its own order."""

import math
import re

from aule_agent.timing import STAGES, Timing
from aule_agent.usage import Usage

MAX_METRICS = 40
NAME = re.compile(r"[a-z0-9_]{1,40}")
# The worker's own measures of a session (worker.entrypoint, cleanup).
MEASURES = {
    "minutes": 12.5,
    "breaks_taken": 1,
    "closed_for_inactivity": 0,
    "closed_after_goodbye": 0,
}


def every_stage_timed() -> dict[str, float]:
    timing = Timing()
    timing.user_state("listening", "speaking")
    timing.user_state("speaking", "listening")
    timing.heard(0.9)
    timing.pressed()
    timing.final_heard()
    timing.released()
    timing.committed()
    for stage in STAGES:
        timing.took(stage, 0.5, timing.turn)
    timing.agent_state("speaking")
    return timing.summary()


def fits_the_platform(metrics: dict[str, float]) -> None:
    assert len(metrics) <= MAX_METRICS, len(metrics)
    for name, value in metrics.items():
        assert NAME.fullmatch(name), name
        assert isinstance(value, int | float) and not isinstance(value, bool), name
        assert math.isfinite(value), name


def test_a_session_with_every_stage_timed_fits_what_the_platform_keeps():
    timing = every_stage_timed()
    assert {f"{stage}_ms_p90" for stage in STAGES} <= set(timing)

    fits_the_platform({**Usage().summary(), **timing, **MEASURES})
