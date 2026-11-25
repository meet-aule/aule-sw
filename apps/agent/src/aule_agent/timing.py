"""How a session felt to the student: how long the tutor took to answer, and
how sure the speech recognition was of what it heard. Sent with the session's
other measures when it ends; only numbers, never what was said.

A reply is timed from the moment the student stops speaking to the moment the
tutor starts, whatever it says first. A typed message has no such moment and
is not timed.

With the talk button each turn is also timed stage by stage, from the moment
the page says the button went up (its end_turn request arrives, the page's
tail and the trip after the release) to the tutor's first audio. A stage that
reports after that first audio, or for an older turn, is not counted, and
neither is a turn whose commit took no words or that waited longer than a
reply can.
"""

import statistics
import time
from collections.abc import Callable

# Longer than this the tutor did not answer that turn at all (it waited for
# more, or the student went on); it is not a reply time.
LONGEST_REPLY_SECONDS = 30.0
# A final transcript under this is likely to be a mishearing.
LOW_CONFIDENCE = 0.6

# The stages of a push-to-talk reply. Each is reported as ``<stage>_ms_p50``
# and ``<stage>_ms_p90`` of the session.
STAGES = (
    # From the page's end_turn to the turn committed.
    "commit",
    # From end_turn to the turn's last final transcript; below zero when it
    # came first, which is how long the student held the button after speaking.
    "stt_final",
    # The input gates, a second reader included.
    "gates_in",
    # From the model request to its first streamed chunk.
    "llm_ttft",
    # From the model request to its first whole sentence, or to knowing that
    # the step calls a tool.
    "first_sentence",
    # The output gate.
    "gate_out",
    # From the text sent to the voice to its first audio, for the first audio heard.
    "tts_ttfb",
    # From end_turn to the tutor's first audio.
    "first_audio",
)


def _p90(values: list[float]) -> float:
    ordered = sorted(values)
    return ordered[max(0, int(len(ordered) * 0.9 + 0.5) - 1)]


class Timing:
    def __init__(self, clock: Callable[[], float] = time.monotonic) -> None:
        self._clock = clock
        self._stopped_at: float | None = None
        self._replies: list[float] = []
        self._confidences: list[float] = []
        # The staged turn: its number, whether it is still waiting for the
        # first audio, when end_turn arrived and what each stage took.
        self._turn = 0
        self._open = False
        self._released_at = 0.0
        self._last_final: float | None = None
        self._current: dict[str, float] = {}
        self._stages: dict[str, list[float]] = {stage: [] for stage in STAGES}
        self._staged = 0

    def user_state(self, old: str, new: str) -> None:
        """The student started or stopped speaking."""
        if new == "speaking":
            self._stopped_at = None
        elif old == "speaking":
            self._stopped_at = self._clock()

    def agent_state(self, new: str) -> None:
        """The tutor started speaking: the end of a wait, if one was open."""
        if new != "speaking":
            return
        if self._open:
            self._open = False
            first_audio = self._clock() - self._released_at
            # Later than this the tutor said something else than an answer
            # to that turn (a break, the warning before the end): no time.
            if first_audio <= LONGEST_REPLY_SECONDS:
                self._current["first_audio"] = first_audio
                for stage, seconds in self._current.items():
                    self._stages[stage].append(seconds)
                self._staged += 1
        if self._stopped_at is None:
            return
        waited = self._clock() - self._stopped_at
        self._stopped_at = None
        if 0 <= waited <= LONGEST_REPLY_SECONDS:
            self._replies.append(waited)

    def heard(self, confidence: float) -> None:
        """The confidence of one final transcript, from 0 to 1."""
        if 0 < confidence <= 1:
            self._confidences.append(confidence)

    @property
    def turn(self) -> int:
        """The staged turn waiting for its first audio, or 0 when there is none.
        A stage is reported with the turn it was measured for."""
        return self._turn if self._open else 0

    def pressed(self) -> None:
        """The talk button went down: what is heard from now on is a new turn's."""
        self._last_final = None

    def final_heard(self) -> None:
        """A final transcript with words in it arrived."""
        self._last_final = self._clock()

    def released(self) -> None:
        """The page's end_turn arrived: a staged turn opens. One still open,
        which never got to speak, is dropped."""
        self._turn += 1
        self._open = True
        self._released_at = self._clock()
        self._current = {}

    def committed(self) -> None:
        """The turn is committed: what was heard of it is all it will have."""
        if not self._open:
            return
        self._current["commit"] = self._clock() - self._released_at
        if self._last_final is not None:
            self._current["stt_final"] = self._last_final - self._released_at

    def nothing_heard(self) -> None:
        """The commit took no words: LiveKit makes no turn of it and the tutor
        does not answer, so the staged turn closes untimed."""
        self._open = False

    def took(self, stage: str, seconds: float, turn: int) -> None:
        """One stage of ``turn`` took this long. The first report of a stage counts."""
        if turn and turn == self.turn and stage in self._stages and stage not in self._current:
            self._current[stage] = seconds

    def summary(self) -> dict[str, float]:
        out: dict[str, float] = {}
        if self._replies:
            replies = sorted(self._replies)
            out["replies_timed"] = len(replies)
            out["reply_ms_p50"] = round(statistics.median(replies) * 1000)
            out["reply_ms_p90"] = round(_p90(replies) * 1000)
            out["reply_ms_max"] = round(replies[-1] * 1000)
        if self._confidences:
            heard = self._confidences
            out["stt_finals"] = len(heard)
            out["stt_confidence_mean"] = round(statistics.fmean(heard), 3)
            out["stt_low_confidence_share"] = round(
                sum(c < LOW_CONFIDENCE for c in heard) / len(heard), 3
            )
        if self._staged:
            out["turns_staged"] = self._staged
            for stage, values in self._stages.items():
                if values:
                    out[f"{stage}_ms_p50"] = round(statistics.median(values) * 1000)
                    out[f"{stage}_ms_p90"] = round(_p90(values) * 1000)
        return out
