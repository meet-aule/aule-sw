"""Keep the same tutor briefly after the child leaves, without keeping a turn open."""

import asyncio

from livekit import rtc
from livekit.agents import AgentSession

GRACE_SECONDS = 120.0


class ReconnectGrace:
    def __init__(self, room: rtc.Room, session: AgentSession) -> None:
        self.room = room
        self.session = session
        self.absent: str | None = None
        self.timer: asyncio.TimerHandle | None = None
        room.on("participant_disconnected", self.left)
        room.on("participant_connected", self.returned)

    def left(self, participant: rtc.RemoteParticipant) -> None:
        if participant.kind == rtc.ParticipantKind.PARTICIPANT_KIND_AGENT:
            return
        if self.timer:
            self.timer.cancel()
        self.absent = participant.identity
        # A button released while offline must not commit a partial utterance.
        self.session.interrupt()
        self.session.clear_user_turn()
        self.timer = asyncio.get_running_loop().call_later(GRACE_SECONDS, self.expired)

    def returned(self, participant: rtc.RemoteParticipant) -> None:
        if participant.identity != self.absent:
            return
        self.absent = None
        if self.timer:
            self.timer.cancel()
            self.timer = None

    def expired(self) -> None:
        self.timer = None
        if self.absent is not None:
            self.session.shutdown()

    def close(self) -> None:
        if self.timer:
            self.timer.cancel()
            self.timer = None
        self.room.off("participant_disconnected", self.left)
        self.room.off("participant_connected", self.returned)
