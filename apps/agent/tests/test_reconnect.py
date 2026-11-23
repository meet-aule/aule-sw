import asyncio
from types import SimpleNamespace
from unittest.mock import Mock

from livekit import rtc

from aule_agent.reconnect import ReconnectGrace


def participant(identity: str = "synthetic-child", agent: bool = False):
    return SimpleNamespace(
        identity=identity,
        kind=(
            rtc.ParticipantKind.PARTICIPANT_KIND_AGENT
            if agent
            else rtc.ParticipantKind.PARTICIPANT_KIND_STANDARD
        ),
    )


async def test_reload_cancels_partial_input_and_preserves_the_session_until_return():
    room, session = Mock(), Mock()
    grace = ReconnectGrace(room, session)
    grace.left(participant())
    session.interrupt.assert_called_once()
    session.clear_user_turn.assert_called_once()
    session.shutdown.assert_not_called()
    timer = grace.timer
    assert 119 < timer.when() - asyncio.get_running_loop().time() <= 120
    grace.returned(participant("another-identity"))
    assert grace.absent is not None
    grace.returned(participant())
    assert timer.cancelled() and grace.absent is None
    grace.expired()
    session.shutdown.assert_not_called()
    grace.close()
    assert room.off.call_count == 2


async def test_an_abandoned_session_stops_and_cleanup_cancels_the_timer():
    room, session = Mock(), Mock()
    grace = ReconnectGrace(room, session)
    grace.left(participant(agent=True))
    assert grace.timer is None
    grace.left(participant())
    old = grace.timer
    grace.left(participant())
    assert old.cancelled()
    timer = grace.timer
    grace.close()
    assert timer.cancelled()
    grace.expired()
    session.shutdown.assert_called_once()
