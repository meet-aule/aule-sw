import asyncio

import latency_harness as harness
import pytest
from fakes import Delays, TurnPlan, World, words_of

from aule_agent.pace import (
    BREAK_COOLDOWN_SECONDS,
    IDLE_ASK_SECONDS,
    IDLE_CLOSE_SECONDS,
    QUIET_TIMEOUT_SECONDS,
    Pace,
    says_tired,
    warning,
)
from aule_agent.replies import BREAKS, REPLIES, RESTS


class Time:
    """A clock that only moves when somebody sleeps, so an hour takes no time."""

    def __init__(self):
        self.now = 0.0

    def clock(self):
        return self.now

    async def sleep(self, seconds):
        self.now += seconds
        await asyncio.sleep(0)


class Session:
    """What the pace needs of a voice session: who is talking, and a voice."""

    def __init__(self, time):
        self.time = time
        self.agent_state = "listening"
        self.user_state = "listening"
        self.said = []
        self.closed_at = None

    async def say(self, text, *, add_to_chat_ctx, allow_interruptions):
        self.said.append((self.time.now, text, add_to_chat_ctx, allow_interruptions))

    def shutdown(self):
        self.closed_at = self.time.now


def pace(minutes=60, break_minutes=5, taken=None):
    time = Time()
    session = Session(time)
    made = Pace(
        session,
        "es",
        max_minutes=minutes,
        break_minutes=break_minutes,
        taken=taken,
        clock=time.clock,
        sleep=time.sleep,
    )
    return made, session, time


def line(key):
    return REPLIES[key]["es"]


@pytest.mark.parametrize(
    ("minutes", "expected"),
    [
        (60, (5, "five_minutes_left")),
        (10, (5, "five_minutes_left")),
        (9, (2, "two_minutes_left")),
        (3, (2, "two_minutes_left")),
        (2, None),
        (1, None),
    ],
)
def test_the_end_is_announced_five_minutes_before_or_two_in_a_short_session(minutes, expected):
    assert warning(minutes) == expected


async def test_a_session_is_warned_and_then_said_goodbye_to_and_closed():
    made, session, _ = pace(minutes=60)

    await made.run()

    assert session.said == [
        # The warning stays in the conversation, so the tutor knows; the
        # goodbye does not. Neither can be talked over.
        (55 * 60.0, line("five_minutes_left"), True, False),
        (60 * 60.0, line("goodbye"), False, False),
    ]
    assert session.closed_at == 60 * 60.0
    assert made.minutes() == 60


async def test_a_session_too_short_for_a_warning_still_gets_its_goodbye():
    made, session, _ = pace(minutes=2)

    await made.run()

    assert [text for _, text, _, _ in session.said] == [line("goodbye")]


async def test_nothing_is_said_over_the_tutor_or_the_student():
    made, session, time = pace(minutes=10)
    session.agent_state = "speaking"

    async def finish_the_reply():
        # The tutor is mid-reply when the warning is due, then the student
        # answers at once; the warning waits for both.
        while time.now < 5 * 60 + 4:
            await asyncio.sleep(0)
        session.agent_state, session.user_state = "listening", "speaking"
        while time.now < 5 * 60 + 7:
            await asyncio.sleep(0)
        session.user_state = "listening"

    await asyncio.gather(made.run(), finish_the_reply())

    warned_at = session.said[0][0]
    assert 5 * 60 + 7 <= warned_at < 5 * 60 + 8
    # The goodbye is still on time: the wait does not push the end back.
    assert session.closed_at == 10 * 60.0


async def test_a_line_is_not_held_back_for_ever_by_a_session_that_never_goes_quiet():
    made, session, _ = pace(minutes=10)
    session.agent_state = "thinking"

    await made.run()

    assert session.said[0][0] == pytest.approx(5 * 60 + QUIET_TIMEOUT_SECONDS)


async def test_a_break_proposes_one_activity_and_asks_to_go_on_when_it_is_over():
    counted = []
    made, session, time = pace(break_minutes=5, taken=counted.append)
    time.now = 30 * 60.0

    await made.take_a_break()
    # Offered again while the break is on, as the platform does: nothing new.
    await made.take_a_break()
    for _ in range(5):
        await asyncio.sleep(0)

    assert counted == [1] and made.breaks_taken == 1
    assert session.said == [
        (30 * 60.0, line(BREAKS[0]), True, False),
        # Nobody talked for the whole break: the tutor asks, and can be answered over.
        (35 * 60.0, line("break_over"), True, True),
    ]


async def test_a_student_who_talks_ends_the_break_and_is_not_asked_to_go_on():
    made, session, time = pace(break_minutes=5)

    await made.take_a_break()
    time.now += 90
    made.student_spoke()
    await time.sleep(10 * 60)
    for _ in range(5):
        await asyncio.sleep(0)

    assert [text for _, text, _, _ in session.said] == [line(BREAKS[0])]


async def test_a_break_just_taken_is_not_offered_again_and_the_next_one_is_another_activity():
    made, session, time = pace()

    await made.take_a_break()
    made.student_spoke()
    time.now += BREAK_COOLDOWN_SECONDS - 1
    await made.take_a_break()
    assert made.breaks_taken == 1

    time.now += 2
    await made.take_a_break()
    made.close()

    assert made.breaks_taken == 2
    assert [text for _, text, _, _ in session.said] == [line(BREAKS[0]), line(BREAKS[1])]


def test_there_is_a_line_for_every_break_and_they_alternate_waking_and_calming():
    assert set(BREAKS) <= set(REPLIES)
    assert BREAKS == ("break_stars", "break_balloon", "break_mirror", "break_cat")


async def watched(made, time, seconds):
    """Lets the watch run for a while of the session's own time."""
    task = asyncio.create_task(made.watch())
    end = time.now + seconds
    while time.now < end and not task.done():
        await asyncio.sleep(0)
    if not task.done():
        task.cancel()
    return task


async def test_a_silent_student_is_asked_once_and_then_the_session_closes():
    made, session, time = pace()

    await watched(made, time, IDLE_ASK_SECONDS + IDLE_CLOSE_SECONDS + 30)

    said = [(at, text) for at, text, _, _ in session.said]
    assert [text for _, text in said] == [line("still_there"), line("idle_goodbye")]
    asked, closed = said[0][0], said[1][0]
    assert IDLE_ASK_SECONDS <= asked < IDLE_ASK_SECONDS + 10
    assert closed - asked >= IDLE_CLOSE_SECONDS and session.closed_at == closed
    assert made.closed_for_inactivity


async def test_a_student_who_answers_the_question_keeps_the_session():
    made, session, time = pace()
    task = asyncio.create_task(made.watch())
    while not session.said:
        await asyncio.sleep(0)
    made.student_spoke()
    end = time.now + IDLE_CLOSE_SECONDS + 30
    while time.now < end:
        await asyncio.sleep(0)
    task.cancel()

    assert [text for _, text, _, _ in session.said] == [line("still_there")]
    assert session.closed_at is None and not made.closed_for_inactivity


async def test_a_turn_that_never_joins_the_conversation_still_keeps_the_session():
    # One the engine answers or a gate stops: the student is there all the same.
    made, session, time = pace()
    task = asyncio.create_task(made.watch())
    while not session.said:
        await asyncio.sleep(0)
    made.student_is_there()
    end = time.now + IDLE_CLOSE_SECONDS + 30
    while time.now < end:
        await asyncio.sleep(0)
    task.cancel()

    assert [text for _, text, _, _ in session.said] == [line("still_there")]
    assert session.closed_at is None and not made.closed_for_inactivity


async def test_such_a_turn_does_not_end_a_break():
    made, session, time = pace(break_minutes=10)
    await made.take_a_break()
    made.student_is_there()

    # Still on the break: nothing is asked of a student who is resting.
    await watched(made, time, IDLE_ASK_SECONDS * 2)
    assert [text for _, text, _, _ in session.said] == [line(BREAKS[0])]


async def test_silence_while_the_tutor_talks_or_on_a_break_is_not_inactivity():
    made, session, time = pace(break_minutes=10)
    session.agent_state = "speaking"
    await watched(made, time, IDLE_ASK_SECONDS * 2)
    assert session.said == []

    session.agent_state = "listening"
    await made.take_a_break()
    await watched(made, time, IDLE_ASK_SECONDS * 2)
    assert [text for _, text, _, _ in session.said] == [line(BREAKS[0])]


async def test_a_goodbye_is_said_back_once_and_closes_the_session():
    made, session, time = pace()

    await made.farewell()
    await made.farewell()

    assert [said[1] for said in session.said] == [REPLIES["farewell"]["es"]]
    assert session.closed_at is not None and made.closed_after_goodbye


# --- A tired student ---------------------------------------------------------


@pytest.mark.parametrize(
    "said",
    [
        "Estoy cansado",
        "uff, estoy cansadísima",
        "ya me cansé",
        "¿podemos descansar un rato?",
        "tengo sueño",
        "me muero de sueño",
        "estoy agotada",
        "ya no puedo más",
        "I'm tired",
        "so sleepy",
    ],
)
def test_a_student_who_says_they_are_tired_is_heard_in_their_own_words(said):
    assert says_tired(said)


@pytest.mark.parametrize(
    "said",
    ["tuve un sueño muy raro", "estoy aburrido", "me da siete octavos", "two cans of paint", ""],
)
def test_a_dream_boredom_or_an_answer_is_not_tiredness(said):
    assert not says_tired(said)


async def test_a_break_after_the_student_said_they_are_tired_is_a_calm_one():
    made, session, time = pace()

    made.student_spoke(tired=True)
    await made.take_a_break()
    made.student_spoke()
    time.now += BREAK_COOLDOWN_SECONDS + 1
    # A break for another reason, such as a block of work that is over.
    await made.take_a_break()
    made.student_spoke(tired=True)
    time.now += BREAK_COOLDOWN_SECONDS + 1
    await made.take_a_break()
    made.close()

    assert [text for _, text, _, _ in session.said] == [
        line(RESTS[0]),
        line(BREAKS[0]),
        line(RESTS[1]),
    ]


def test_a_calm_break_is_asked_and_never_sends_the_student_moving():
    assert set(RESTS) <= set(REPLIES) and not set(RESTS) & set(BREAKS)
    for key in RESTS:
        for language, text in REPLIES[key].items():
            # An invitation: a question the student may answer with a no.
            assert "?" in text, (key, language)
            moving = ("salt", "rápido", "de pie", "jump", "faster", "stand up")
            assert not any(word in text.lower() for word in moving), (key, language)


def heard(world):
    return " ".join(" ".join(text for said in world.played for text in said.texts).split())


def spoken(key):
    return " ".join(REPLIES[key]["es"].split())


async def a_session_with_a_break(words):
    """A free session of one turn, ``words``, after which the platform offers
    a break; it ends once a break's line has been heard."""
    lines = [spoken(key) for key in (*BREAKS, *RESTS)]
    with harness.offline():
        world = World(seed=5, delays=Delays(scale=0.05))
        world.platform.break_after = words
        world.plans[words] = TurnPlan(reply="Te entiendo.")
        turn = harness.Turn(1, "reply", words, 0.4, 0.1)
        await harness.run_session(
            world, [turn], until=lambda: any(said in heard(world) for said in lines)
        )
    return world


async def test_in_a_session_a_tired_student_is_offered_a_calm_break_and_others_an_active_one():
    tired = await a_session_with_a_break(words_of(1, "estoy muy cansado"))
    other = await a_session_with_a_break(words_of(1))

    assert spoken(RESTS[0]) in heard(tired)
    assert not [key for key in BREAKS if spoken(key) in heard(tired)]
    assert spoken(BREAKS[0]) in heard(other)
    assert not [key for key in RESTS if spoken(key) in heard(other)]
    # The platform hears that the break was taken, either way.
    for world in (tired, other):
        assert world.metrics["breaks_taken"] == 1
