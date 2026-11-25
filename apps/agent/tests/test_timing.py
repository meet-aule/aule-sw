import pytest

from aule_agent.timing import LONGEST_REPLY_SECONDS, Timing


class Clock:
    def __init__(self):
        self.now = 0.0

    def __call__(self):
        return self.now


def test_a_reply_is_timed_from_the_end_of_speech_to_the_first_word():
    clock = Clock()
    timing = Timing(clock)

    for waited in (2.0, 3.0, 4.0, 10.0):
        timing.user_state("listening", "speaking")
        clock.now += 3
        timing.user_state("speaking", "listening")
        clock.now += waited
        timing.agent_state("thinking")
        timing.agent_state("speaking")

    summary = timing.summary()
    assert summary["replies_timed"] == 4
    assert summary["reply_ms_p50"] == 3500
    assert summary["reply_ms_p90"] == 10000
    assert summary["reply_ms_max"] == 10000


def test_what_is_not_a_reply_is_not_timed():
    clock = Clock()
    timing = Timing(clock)

    # The tutor speaks first: nobody was waiting.
    timing.agent_state("speaking")
    # The student pauses and goes on: the wait starts again from the new end.
    timing.user_state("listening", "speaking")
    timing.user_state("speaking", "listening")
    clock.now += 1
    timing.user_state("listening", "speaking")
    clock.now += 2
    timing.user_state("speaking", "listening")
    clock.now += 2.5
    timing.agent_state("speaking")
    # A turn the tutor did not answer for a long time.
    timing.user_state("listening", "speaking")
    timing.user_state("speaking", "listening")
    clock.now += LONGEST_REPLY_SECONDS + 1
    timing.agent_state("speaking")

    assert timing.summary()["replies_timed"] == 1
    assert timing.summary()["reply_ms_max"] == 2500


def test_how_sure_the_hearing_was():
    timing = Timing()
    for confidence in (0.95, 0.9, 0.4, 0.0, 1.5):
        timing.heard(confidence)

    summary = timing.summary()
    assert summary["stt_finals"] == 3
    assert summary["stt_confidence_mean"] == 0.75
    assert summary["stt_low_confidence_share"] == 0.333


def test_a_session_with_nothing_to_measure_sends_nothing():
    assert Timing().summary() == {}


def staged_turn(timing, clock, *, held=0.0, stages=(), late=()):
    """One push-to-talk turn: press, a final transcript, release, commit,
    the stages, then the first audio."""
    timing.pressed()
    timing.final_heard()
    clock.now += held
    timing.released()
    turn = timing.turn
    clock.now += 0.1
    timing.committed()
    for stage, seconds in stages:
        timing.took(stage, seconds, turn)
    clock.now += 1.0
    timing.agent_state("speaking")
    for stage, seconds in late:
        timing.took(stage, seconds, turn)
    return turn


def test_a_push_to_talk_turn_is_timed_stage_by_stage_from_end_turn():
    clock = Clock()
    timing = Timing(clock)

    for gates in (0.2, 0.3, 0.4):
        staged_turn(timing, clock, held=0.5, stages=[("gates_in", gates), ("llm_ttft", 0.8)])

    summary = timing.summary()
    assert summary["turns_staged"] == 3
    assert summary["commit_ms_p50"] == 100
    # The final came before the button went up: how long it was held.
    assert summary["stt_final_ms_p50"] == -500
    assert (summary["gates_in_ms_p50"], summary["gates_in_ms_p90"]) == (300, 400)
    assert summary["llm_ttft_ms_p50"] == 800
    assert summary["first_audio_ms_p50"] == 1100
    assert "gate_out_ms_p50" not in summary


def test_a_stage_after_the_first_audio_or_of_another_turn_is_not_counted():
    clock = Clock()
    timing = Timing(clock)

    first = staged_turn(timing, clock, stages=[("gates_in", 0.2)], late=[("gate_out", 9.0)])
    timing.pressed()
    timing.released()
    timing.committed()
    timing.took("gates_in", 5.0, first)  # the turn before, late
    timing.took("gates_in", 6.0, 0)  # no staged turn (a typed message)
    timing.took("gates_in", 0.3, timing.turn)
    timing.took("gates_in", 7.0, timing.turn)  # the first report of a stage counts
    timing.took("unknown", 1.0, timing.turn)
    timing.agent_state("speaking")

    summary = timing.summary()
    assert summary["turns_staged"] == 2
    assert (summary["gates_in_ms_p50"], summary["gates_in_ms_p90"]) == (250, 300)
    assert "gate_out_ms_p50" not in summary and "unknown_ms_p50" not in summary
    # No final was heard in the second turn: the first turn's is not taken
    # for it, which would put a wait below zero there.
    assert (summary["stt_final_ms_p50"], summary["stt_final_ms_p90"]) == (0, 0)


def test_a_turn_that_never_got_to_speak_is_dropped_and_vad_mode_has_no_stages():
    clock = Clock()
    timing = Timing(clock)

    timing.released()
    timing.took("gates_in", 0.2, timing.turn)
    timing.released()
    timing.agent_state("speaking")
    assert timing.summary()["turns_staged"] == 1
    assert "gates_in_ms_p50" not in timing.summary()

    plain = Timing(clock)
    plain.user_state("listening", "speaking")
    plain.user_state("speaking", "listening")
    plain.agent_state("speaking")
    assert "turns_staged" not in plain.summary() and plain.turn == 0


def test_a_release_that_committed_no_words_is_no_turn_and_is_not_timed():
    clock = Clock()
    timing = Timing(clock)
    staged_turn(timing, clock, stages=[("gates_in", 0.2)])

    # A tap: LiveKit makes no turn of a commit with no words, and nothing answers it.
    timing.pressed()
    timing.released()
    turn = timing.turn
    clock.now += 0.1
    timing.nothing_heard()
    timing.took("gates_in", 0.3, turn)
    # What the tutor says next (the question after a silence) is no answer to it.
    clock.now += 180
    timing.agent_state("speaking")

    summary = timing.summary()
    assert timing.turn == 0 and summary["turns_staged"] == 1
    assert (summary["first_audio_ms_p50"], summary["first_audio_ms_p90"]) == (1100, 1100)
    assert (summary["gates_in_ms_p50"], summary["gates_in_ms_p90"]) == (200, 200)


def test_a_staged_turn_answered_later_than_a_reply_can_be_is_not_timed():
    clock = Clock()
    timing = Timing(clock)
    staged_turn(timing, clock)

    timing.pressed()
    timing.final_heard()
    timing.released()
    timing.committed()
    timing.took("gates_in", 0.2, timing.turn)
    clock.now += LONGEST_REPLY_SECONDS + 1
    timing.agent_state("speaking")

    summary = timing.summary()
    assert timing.turn == 0 and summary["turns_staged"] == 1
    assert summary["first_audio_ms_p90"] == 1100 and "gates_in_ms_p50" not in summary


def test_a_final_that_comes_after_its_turn_was_committed_is_counted():
    clock = Clock()
    timing = Timing(clock)
    staged_turn(timing, clock)
    assert timing.summary()["stt_finals_after_commit"] == 0

    # A word said as the button went up, finalized only once the turn was committed.
    timing.final_heard()
    timing.pressed()
    timing.final_heard()
    timing.released()
    timing.nothing_heard()
    timing.final_heard()

    assert timing.summary()["stt_finals_after_commit"] == 2


def test_a_counted_staged_turn_is_told_with_its_trace_id_as_it_closes():
    clock = Clock()
    timing = Timing(clock)
    told = []
    timing.on_staged = lambda trace, stages: told.append((trace, stages))

    # No staged turn is open: a typed message, or the microphone open.
    timing.traced("trace-0")
    timing.pressed()
    timing.final_heard()
    timing.released()
    # An older turn's id, late, then the turn's own: the latest counts.
    timing.traced("trace-older")
    timing.traced("trace-1")
    clock.now += 0.1
    timing.committed()
    timing.took("gates_in", 0.3, timing.turn)
    clock.now += 1.0
    timing.agent_state("speaking")

    assert told == [
        (
            "trace-1",
            pytest.approx({"commit": 0.1, "stt_final": 0.0, "gates_in": 0.3, "first_audio": 1.1}),
        )
    ]

    # A tap that commits nothing, and a wait no reply takes, are not told.
    timing.pressed()
    timing.released()
    timing.nothing_heard()
    timing.agent_state("speaking")
    timing.pressed()
    timing.released()
    timing.traced("trace-3")
    timing.committed()
    clock.now += LONGEST_REPLY_SECONDS + 1
    timing.agent_state("speaking")
    assert len(told) == 1

    # A new release forgets the last turn's id.
    timing.pressed()
    timing.released()
    timing.committed()
    clock.now += 1.0
    timing.agent_state("speaking")
    assert [trace for trace, _ in told] == ["trace-1", None]
