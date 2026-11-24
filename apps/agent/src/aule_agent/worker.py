"""The LiveKit Agents worker: one tutor session per room it is dispatched to.

Run it with ``python -m aule_agent.worker start`` (``dev`` while developing).
The worker only joins rooms that ask for it by name (explicit dispatch).
"""

import asyncio
import json
import logging
import os
import sys
from dataclasses import replace
from typing import Any

from livekit import rtc
from livekit.agents import (
    AgentServer,
    AgentSession,
    CloseEvent,
    JobContext,
    JobProcess,
    cli,
    room_io,
)
from livekit.plugins import silero

from . import visuals
from .camera import Camera
from .config import LANGUAGES, ConfigError, Settings
from .pace import Pace
from .platform import Platform, platform_session
from .providers import build_llm, build_stt, build_tts
from .reconnect import ReconnectGrace
from .replies import reply
from .safety import audience_of, build_gates
from .script import Reply
from .timing import Timing
from .tutor import Persona, Tutor, persona_from
from .usage import Usage

logger = logging.getLogger("aule.agent")

# The decorator needs the name at import time; Settings validates the rest.
AGENT_NAME = os.environ.get("AULE_AGENT_NAME", "").strip() or "aule-tutor"


def language_of(dispatch_metadata: str, default: str) -> str:
    try:
        metadata = json.loads(dispatch_metadata or "{}")
    except ValueError:
        return default
    language = metadata.get("language") if isinstance(metadata, dict) else None
    return language if language in LANGUAGES else default


def persona_of(dispatch_metadata: str) -> Persona:
    """The tutor's persona from the dispatch metadata. Always present (defaults
    when there is no child); the platform's GET body overrides it when set."""
    try:
        metadata = json.loads(dispatch_metadata or "{}")
    except ValueError:
        metadata = {}
    if not isinstance(metadata, dict):
        metadata = {}
    return persona_from(
        metadata.get("tutor_name"),
        metadata.get("tutor_persona"),
        metadata.get("tutor_persona_note"),
    )


# How long a released talk button waits for the last final transcript.
COMMIT_TRANSCRIPT_TIMEOUT_SECONDS = 0.8


async def enable_push_to_talk(ctx: JobContext, session: AgentSession) -> None:
    """Hand turn-taking to the client's talk button. The attribute tells the page
    to show the hold-to-talk control; the RPCs it sends drive each turn: start on
    press, commit on release, cancel on abandon.
    """
    await ctx.room.local_participant.set_attributes({"aule.turns": "manual"})

    async def start_turn(_: rtc.RpcInvocationData) -> str:
        session.interrupt()
        session.clear_user_turn()
        return "ok"

    async def end_turn(_: rtc.RpcInvocationData) -> str:
        # The microphone stays attached, so there is no flush to wait for: a
        # short wait lets a final transcript in flight land, and whatever is
        # still interim is committed as it stands.
        await session.commit_user_turn(transcript_timeout=COMMIT_TRANSCRIPT_TIMEOUT_SECONDS)
        return "ok"

    async def cancel_turn(_: rtc.RpcInvocationData) -> str:
        session.clear_user_turn()
        return "ok"

    local = ctx.room.local_participant
    local.register_rpc_method("start_turn", start_turn)
    local.register_rpc_method("end_turn", end_turn)
    local.register_rpc_method("cancel_turn", cancel_turn)


# Homes are noisy: a door, a pan, the television, a sibling. These are the free
# measures against it; a voice that is not the student's still gets through
# (only push-to-talk stops that).
#
# Voice detection: a sound must last this long and sound this much like speech
# to count, so a bang or a clatter does not start a turn. Children speak
# softly, so the bar stays near the default.
SPEECH_MIN_SECONDS = 0.12
SPEECH_LIKELIHOOD = 0.55
TURNS: dict[str, Any] = {
    # A child pauses to think in the middle of a sentence: wait a little longer
    # before taking the turn as finished.
    "endpointing": {"min_delay": 0.7, "max_delay": 4.0},
    "interruption": {
        # Voice detection on this server; the learned detector is LiveKit Cloud's.
        "mode": "vad",
        # The tutor stops for the student, not for a noise: speech this long,
        # with at least one word the transcriber made out. A noise that does
        # stop it is undone (resume after a silence, LiveKit's default).
        "min_duration": 0.8,
        "min_words": 1,
    },
}


def prewarm(proc: JobProcess) -> None:
    proc.userdata["vad"] = silero.VAD.load(
        min_speech_duration=SPEECH_MIN_SECONDS, activation_threshold=SPEECH_LIKELIHOOD
    )
    # The model's client takes seconds to import. Done here it is paid while
    # the process waits for a session, not while a student waits for hello.
    from livekit.plugins import anthropic  # noqa: F401


# A session takes a warm process and a new one takes seconds to start, so the
# number kept warm is how many students can join at the same moment without
# waiting. One is enough for a small server; each holds the VAD model.
# The worker's health endpoint stays on loopback unless told otherwise.
server = AgentServer(
    setup_fnc=prewarm,
    num_idle_processes=int(os.environ.get("AULE_IDLE_PROCESSES", "1")),
    host=os.environ.get("AULE_HEALTH_HOST", "127.0.0.1"),
    port=int(os.environ.get("AULE_HEALTH_PORT", "8081")),
)


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    settings = Settings.from_env()
    audience = audience_of(ctx.job.metadata)
    language = language_of(ctx.job.metadata, settings.language)

    # With a platform, the tutor starts from what is known about the student
    # and reports the conversation; without one it is a tutor with no memory.
    linked = platform_session(ctx.job.metadata)
    platform = Platform(linked) if linked else None

    # A child's session needs both gates (see safety.py); an operator's runs
    # the ones that are configured.
    gates = build_gates(settings, report=platform.flag if platform else None)
    if not gates.may_start(audience):
        logger.warning("session refused: the safety gates are not configured")
        await gates.close()
        ctx.shutdown(reason="safety gates not configured")
        return

    await ctx.connect()
    camera = Camera(ctx.room)
    context = await platform.start() if platform else ""
    if platform and platform.gone:
        # The session is over for the platform and a page came back to its
        # room. Nobody is greeted: there is no session to hold.
        logger.warning("session refused: the platform no longer serves it")
        await gates.close()
        await platform.end()
        ctx.shutdown(reason="the platform no longer serves this session")
        return

    async def show(visual: dict[str, Any]) -> None:
        # Every Aule screen (the playground today, the device's e-ink
        # later) draws visuals that arrive on this topic.
        await ctx.room.local_participant.send_text(
            json.dumps(visual, ensure_ascii=False), topic=visuals.TOPIC
        )

    # The persona: the dispatch metadata is always present; the platform's GET
    # body wins when it set one (it is read from the database). The family note
    # is moderated once here and dropped if it is unsafe or the gate is down, so
    # it never reaches the model unchecked.
    persona = persona_of(ctx.job.metadata)
    if platform and platform.persona is not None:
        persona = platform.persona
    if persona.note and not (gates.checks_spoken and (await gates.spoken(persona.note)).allowed):
        persona = replace(persona, note=None)

    # How long the tutor takes to answer, and how sure the hearing is.
    timing = Timing()
    tutor = Tutor(
        language=language,
        gates=gates,
        camera=camera,
        context=context,
        show=show,
        persona=persona,
        student_name=platform.student_name if platform else None,
        session_number=platform.session_number if platform else None,
        # With the session engine the answers are its own to check, and the
        # model gets no tools to pose or check an exercise by itself.
        checker=platform if platform and not platform.scripted else None,
        engine=platform if platform and platform.scripted else None,
        # The platform offers the breaks of a session, unless the engine runs
        # it and has breaks of its own.
        breaks=bool(platform and not platform.scripted),
        heard=timing.heard,
    )
    usage = Usage()
    model = build_llm(settings)
    model.on("metrics_collected", usage.add)
    hearing = build_stt(settings, language)
    hearing.on("metrics_collected", usage.heard)
    voice = build_tts(settings, language)
    voice.on("metrics_collected", usage.spoke)
    session = AgentSession(
        stt=hearing,
        llm=model,
        tts=voice,
        vad=ctx.proc.userdata["vad"],
        # Push-to-talk: the talk button commits each turn (see ``push_to_talk``
        # below), so the VAD must not end a turn on its own.
        turn_handling={**TURNS, "turn_detection": "manual"} if settings.push_to_talk else TURNS,
    )
    session.on(
        "user_state_changed", lambda event: timing.user_state(event.old_state, event.new_state)
    )
    session.on("agent_state_changed", lambda event: timing.agent_state(event.new_state))

    def break_taken(count: int) -> None:
        if platform:
            platform.breaks_taken = count

    # The warning before the end, the goodbye, and the breaks in between.
    pace = Pace(
        session,
        language,
        max_minutes=settings.session_max_minutes,
        break_minutes=settings.break_minutes,
        taken=break_taken,
    )
    tasks = [asyncio.create_task(pace.run()), asyncio.create_task(pace.watch())]
    asides: set[asyncio.Task[None]] = set()

    def goodbye() -> None:
        # In its own task: the turn that said goodbye ends at once, and the
        # tutor says it back once it is quiet.
        task = asyncio.create_task(pace.farewell())
        asides.add(task)
        task.add_done_callback(asides.discard)

    tutor.on_goodbye = goodbye

    @session.on("conversation_item_added")
    def back_from_a_break(event) -> None:
        if getattr(event.item, "type", None) == "message" and event.item.role == "user":
            pace.student_spoke()

    if platform:

        @session.on("conversation_item_added")
        def report(event) -> None:
            if getattr(event.item, "type", None) == "message":
                platform.heard(event.item.role, event.item.text_content)

        async def stop(kind: str) -> None:
            # A student who keeps fooling around is warned once, kindly; if it
            # goes on, the session closes and the family is told by the platform.
            if kind == "warn":
                await session.say(
                    reply("not_working_warn", language),
                    allow_interruptions=True,
                    add_to_chat_ctx=True,
                )
                return
            platform.end_reason = "not_working"
            # The reply to the turn that ended it is not said first: the
            # session closes now, not after one more friendly sentence.
            await session.interrupt()
            await session.say(
                reply("not_working_end", language), allow_interruptions=False, add_to_chat_ctx=False
            )
            session.shutdown()

        async def gone() -> None:
            # The platform ended the session, or stopped knowing it: the tutor
            # leaves without a word instead of talking to nobody's account.
            session.shutdown()

        def aside(saying) -> None:
            # In its own task: the reports do not wait for the tutor to speak.
            task = asyncio.create_task(saying)
            asides.add(task)
            task.add_done_callback(asides.discard)

        async def pause() -> None:
            aside(pace.take_a_break())

        async def written(lines: Reply) -> None:
            aside(tutor.scripted_lines(lines))

        tasks.append(
            asyncio.create_task(
                platform.run(
                    tutor.advise, tutor.plan, stop, gone=gone, pause=pause, written=written
                )
            )
        )

    reconnect = ReconnectGrace(ctx.room, session) if audience == "child" else None
    provider_failed = False

    @session.on("close")
    def closed(event: CloseEvent) -> None:
        nonlocal provider_failed
        provider_failed = event.error is not None

    async def cleanup() -> None:
        if reconnect:
            reconnect.close()
        pace.close()
        for task in [*tasks, *asides]:
            task.cancel()
        await asyncio.gather(*tasks, *asides, return_exceptions=True)
        camera.stop()
        logger.info("session usage", extra=usage.summary())
        logger.info("session timing", extra=timing.summary())
        await gates.close()
        if platform:
            if not platform.end_reason:
                platform.end_reason = (
                    "provider_error"
                    if provider_failed
                    else "budget_reached"
                    if pace.closed_for_time
                    else "idle"
                    if pace.closed_for_inactivity
                    else "child_ended"
                    if pace.closed_after_goodbye
                    else "device_offline"
                    if reconnect and reconnect.absent
                    else "child_ended"
                )
            measures = {
                "minutes": round(pace.minutes(), 1),
                "breaks_taken": pace.breaks_taken,
                "closed_for_inactivity": int(pace.closed_for_inactivity),
                "closed_after_goodbye": int(pace.closed_after_goodbye),
            }
            await platform.end({**usage.summary(), **timing.summary(), **measures})

    ctx.add_shutdown_callback(cleanup)

    await session.start(
        agent=tutor,
        room=ctx.room,
        # The camera is read by ``Camera``; the session's own video input only
        # feeds realtime models. Audio is not recorded.
        room_options=room_io.RoomOptions(
            video_input=False,
            delete_room_on_close=True,
            close_on_disconnect=audience != "child",
            # A typed message is judged like a spoken one. LiveKit's own
            # handler would hand it to the model unchecked.
            text_input=room_io.TextInputOptions(
                text_input_cb=lambda _, event: tutor.typed(event.text)
            ),
        ),
        record=False,
    )
    camera.start()

    async def show_work(_: rtc.RpcInvocationData) -> str:
        # The page's button for showing work. It answers "ok" once the tutor
        # has an image to talk about and "no_frame" when the camera sent none.
        pace.student_spoke()
        return "ok" if await tutor.show_work() else "no_frame"

    ctx.room.local_participant.register_rpc_method("show_work", show_work)

    async def answered(_: rtc.RpcInvocationData) -> str:
        # The page sent the engine an answer the student typed. What the engine
        # wrote back comes with the next report, so the report is made now.
        pace.student_spoke()
        if platform:
            platform.wake()
        return "ok"

    ctx.room.local_participant.register_rpc_method("answered", answered)
    # Tells the page that the button has somebody to answer it.
    await ctx.room.local_participant.set_attributes({"aule.show_work": "rpc"})
    if settings.push_to_talk:
        await enable_push_to_talk(ctx, session)
    logger.info("session started", extra={"audience": audience, "language": language})


def main() -> None:
    # Checked here too so a misconfigured worker exits with one clear message
    # instead of registering and failing on its first session.
    if len(sys.argv) > 1 and sys.argv[1] in {"start", "dev"}:
        try:
            settings = Settings.from_env()
        except ConfigError as error:
            sys.exit(f"aule-agent: {error}")
        if not settings.gates_complete:
            logger.warning(
                "OPENAI_API_KEY and TYPESAFE_API_KEY are not both set: "
                "only operator sessions will be accepted"
            )
    cli.run_app(server)


if __name__ == "__main__":
    main()
