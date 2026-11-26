"""The LiveKit Agents worker: one tutor session per room it is dispatched to.

Run it with ``python -m aule_agent.worker start`` (``dev`` while developing).
The worker only joins rooms that ask for it by name (explicit dispatch).
"""

import asyncio
import contextlib
import json
import logging
import os
import sys
from dataclasses import replace
from typing import Any, Protocol

from livekit import rtc
from livekit.agents import (
    Agent,
    AgentServer,
    AgentSession,
    CloseEvent,
    JobContext,
    JobProcess,
    cli,
    room_io,
)
from livekit.plugins import silero

from . import observability, visuals
from ._version import __version__
from .camera import Camera
from .config import LANGUAGES, ConfigError, Settings, build_commit
from .logs import keep_personal_fields_out
from .observability import Observability
from .pace import Pace, says_tired
from .platform import Platform, platform_session
from .providers import build_llm, build_stt, build_tts
from .reconnect import ReconnectGrace
from .replies import reply
from .safety import Audience, Gates, audience_of, build_gates, check_at_start
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


async def someone_joined(ctx: JobContext) -> bool:
    """Waits for the person the session is for. False when the room closed
    before anyone came.

    The platform opens a session's room before the person joins it, so that
    what the agent is told never travels in the person's token. Nothing starts
    until they are in it: the platform is not asked to start the session and
    there is no greeting to pay for. LiveKit closes a room nobody joins.
    """
    try:
        await ctx.wait_for_participant()
    except RuntimeError:
        return False
    return True


# How long a released talk button waits for the last final transcript, when
# one may still be on its way.
COMMIT_TRANSCRIPT_TIMEOUT_SECONDS = 0.8
# How long the last AI observability events of a session wait for its close,
# which runs beside the job's other shutdown callbacks and reports the
# requests it stops.
LAST_EVENTS_SECONDS = 3.0


class Hearing(Protocol):
    """What the tutor heard of the turn being held: the Tutor."""

    @property
    def words_in_flight(self) -> bool: ...

    def hold_started(self) -> None: ...


async def enable_push_to_talk(
    ctx: JobContext,
    session: AgentSession,
    timing: Timing | None = None,
    hearing: Hearing | None = None,
    gates: Gates | None = None,
) -> None:
    """Hand turn-taking to the client's talk button. The attribute tells the page
    to show the hold-to-talk control; the RPCs it sends drive each turn: start on
    press, commit on release, cancel on abandon. ``timing`` times each turn
    from the moment end_turn arrives; ``hearing`` says whether a final
    transcript may still come; ``gates`` get their connections ready while the
    child speaks.
    """
    await ctx.room.local_participant.set_attributes({"aule.turns": "manual"})
    warming: set[asyncio.Task[None]] = set()

    async def start_turn(_: rtc.RpcInvocationData) -> str:
        if timing is not None:
            timing.pressed()
        if gates is not None:
            # Not waited for: the press is answered at once.
            task = asyncio.create_task(gates.warm())
            warming.add(task)
            task.add_done_callback(warming.discard)
        try:
            session.interrupt()
        except RuntimeError:
            # A line that may not be cut (a gate's reply, the line said when
            # the tutor is unavailable) is said to its end. The hold still
            # starts: the child's words are heard and answered after it, where
            # an error here made the page drop the whole turn.
            pass
        session.clear_user_turn()
        if hearing is not None:
            hearing.hold_started()
        return "ok"

    async def end_turn(_: rtc.RpcInvocationData) -> str:
        if timing is not None:
            timing.released()
        # The microphone stays attached, so there is no flush to wait for. A
        # final transcript may still be on its way while the voice detector
        # hears the child speaking, or when the hearing heard more after its
        # last final: then a short wait lets it land, and whatever is still
        # interim is committed as it stands. Otherwise the child stopped
        # before letting go and every word is in: LiveKit would wait the whole
        # time for a final that cannot come.
        settled = (
            hearing is not None and session.user_state != "speaking" and not hearing.words_in_flight
        )
        heard = await session.commit_user_turn(
            transcript_timeout=0.0 if settled else COMMIT_TRANSCRIPT_TIMEOUT_SECONDS
        )
        if timing is not None:
            # A commit with no words is no turn: nothing answers it.
            if heard.strip():
                timing.committed()
            else:
                timing.nothing_heard()
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
    # LiveKit's own early start: in VAD mode it runs the tutor's llm_node
    # before on_user_turn_completed, so the gates had not judged the words
    # the model got, and the output gate judged text that might never be
    # said. The tutor asks early itself where it may (AULE_EARLY_REPLY).
    "preemptive_generation": {"enabled": False},
}
# With the talk button the button ends the turn. The pause TURNS waits for, a
# child going on after thinking, cannot happen once the button is up, and
# LiveKit takes the turn's words as they are at the commit: any wait after it
# only delays the reply.
PUSH_TO_TALK_TURNS: dict[str, Any] = {
    **TURNS,
    "turn_detection": "manual",
    "endpointing": {"min_delay": 0.0, "max_delay": TURNS["endpointing"]["max_delay"]},
}


def prewarm(proc: JobProcess) -> None:
    # A job process has its logging set up by now: what a child says is kept
    # out of it from the first record on.
    keep_personal_fields_out()
    proc.userdata["vad"] = silero.VAD.load(
        min_speech_duration=SPEECH_MIN_SECONDS, activation_threshold=SPEECH_LIKELIHOOD
    )
    # The model's client takes seconds to import. Done here it is paid while
    # the process waits for a session, not while a student waits for hello.
    from livekit.plugins import anthropic  # noqa: F401

    # So is AI observability's client, when it is on.
    with contextlib.suppress(ConfigError):
        observability.prewarm(Settings.from_env())


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


# Tasks the worker runs beside its sessions, kept until they finish.
_background: set[asyncio.Task[None]] = set()


@server.once("worker_started")
def announce() -> None:
    # Once LiveKit has set up the logs, so the line is in them like any other,
    # and so are the fields that would carry a child's words.
    keep_personal_fields_out()
    logger.info("aule-agent %s (%s)", __version__, build_commit())
    task = asyncio.create_task(check_gates())
    _background.add(task)
    task.add_done_callback(_background.discard)


async def check_gates() -> None:
    """Says in the log, once when the worker starts, whether each configured
    gate answers: a refused key or a provider out of reach shows now, not
    first when a child is waiting. Every child's session asks again."""
    try:
        settings = Settings.from_env()
    except ConfigError:
        return  # main() has said what is missing
    await check_at_start(settings)


# How long a refused session waits for its one line to be heard. The voice
# waits until the page listens; a page that never does is waited for this long.
REFUSAL_SECONDS = 20.0


async def refuse(
    ctx: JobContext, settings: Settings, language: str, platform: Platform | None
) -> None:
    """Ends a child's session that cannot have both safety gates, before the
    tutor starts.

    The child hears the fixed line for a tutor that cannot answer safely, in
    their language, and reads it in the transcript; the platform is told the
    tutor's service failed, which the page's end screen explains. Only the
    voice runs: no model, no speech recognition and no session host, and
    nothing the child says or types is read, so nothing gets around the gates.
    """
    session: AgentSession | None = None
    try:
        await ctx.connect()
        # The room opens before the person joins it: the line waits for them,
        # and a room nobody joins just ends.
        if not await someone_joined(ctx):
            return
        session = AgentSession(
            tts=build_tts(settings, language),
            vad=None,
            turn_handling={"turn_detection": "manual"},
        )
        await session.start(
            agent=Agent(instructions=""),
            room=ctx.room,
            room_options=room_io.RoomOptions(
                audio_input=False, text_input=False, video_input=False
            ),
            session_host=False,
            record=False,
        )
        async with asyncio.timeout(REFUSAL_SECONDS):
            await session.say(
                reply("unavailable", language), allow_interruptions=False, add_to_chat_ctx=False
            )
    except Exception as error:
        # Said or not, the session ends: no tutor starts without its gates.
        logger.warning("refusal not said", extra={"error": type(error).__name__})
    finally:
        try:
            # Before the room goes, so the page finds out why when it asks.
            if platform:
                platform.end_reason = "provider_error"
                await platform.end()
            if session is not None:
                await session.aclose()
        finally:
            await ctx.delete_room(ctx.job.room.name)
            ctx.shutdown(reason="the safety gates are not ready")


async def admit(
    ctx: JobContext,
    settings: Settings,
    audience: Audience,
    language: str,
    platform: Platform | None,
    observer: Observability | None = None,
) -> tuple[Gates, str] | None:
    """The session's gates and what the platform says the tutor should know,
    or None when the session ends before it starts.

    A child's session needs both gates configured and answering now (see
    ``safety``); without them the child is told, and the platform too. An
    operator's runs the gates that are configured.
    """
    gates = build_gates(settings, report=platform.flag if platform else None, observer=observer)
    if not gates.may_start(audience):
        logger.warning("session refused: the safety gates are not configured")
        await gates.close()
        await refuse(ctx, settings, language, platform)
        return None

    # The gates are asked while the room is joined, the person comes in and
    # the platform is asked about the student, so the check adds nothing to
    # the wait when they answer in time.
    answering = asyncio.create_task(gates.ready()) if audience == "child" else None
    try:
        await ctx.connect()
        if not await someone_joined(ctx):
            logger.info("session not started: nobody joined the room")
            if answering is not None:
                answering.cancel()
            await gates.close()
            if platform:
                # It can never start now: a later join opens a room with no tutor.
                # Closed at once, as the platform closes a session left open, it
                # counts for nothing and the family can start another without waiting.
                platform.end_reason = "device_offline"
                await platform.end()
            ctx.shutdown(reason="nobody joined the room")
            return None
        context = await platform.start() if platform else ""
        ready = await answering if answering is not None else True
    except BaseException:
        if answering is not None:
            answering.cancel()
        await gates.close()
        raise
    if platform and platform.gone:
        # The session is over for the platform and a page came back to its
        # room. Nobody is greeted: there is no session to hold.
        logger.warning("session refused: the platform no longer serves it")
        await gates.close()
        await platform.end()
        ctx.shutdown(reason="the platform no longer serves this session")
        return None
    if not ready:
        logger.warning("session refused: a safety gate does not answer")
        await gates.close()
        await refuse(ctx, settings, language, platform)
        return None
    if platform:
        gates.for_student(platform.student_age, platform.student_grade, platform.student_name)
    return gates, context


@server.rtc_session(agent_name=AGENT_NAME)
async def entrypoint(ctx: JobContext) -> None:
    # Again for a handler added since the process started.
    keep_personal_fields_out()
    settings = Settings.from_env()
    observer = Observability.configured(settings)
    if observer is not None:
        ctx.add_shutdown_callback(observer.close)
    audience = audience_of(ctx.job.metadata)
    language = language_of(ctx.job.metadata, settings.language)

    # With a platform, the tutor starts from what is known about the student
    # and reports the conversation; without one it is a tutor with no memory.
    linked = platform_session(ctx.job.metadata)
    platform = Platform(linked) if linked else None

    admitted = await admit(ctx, settings, audience, language, platform, observer=observer)
    if admitted is None:
        return
    gates, context = admitted
    camera = Camera(ctx.room)

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
    if observer is not None:
        timing.on_staged = observer.turn
    usage = Usage()
    voice = build_tts(settings, language)
    voice.on("metrics_collected", usage.spoke)
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
        timing=timing,
        early_reply=settings.early_reply,
        # The session's own voice: the lines said while a tool works are voiced
        # ahead with it, and with the setting a reply's first sentence too.
        voice=voice,
        voice_ahead=settings.voice_ahead,
    )
    model = build_llm(settings)
    model.on("metrics_collected", usage.add)
    if observer is not None:
        model.on("metrics_collected", observer.llm_metrics)
        model.on("error", observer.llm_error)
    hearing = build_stt(settings, language)
    hearing.on("metrics_collected", usage.heard)
    session = AgentSession(
        stt=hearing,
        llm=model,
        tts=voice,
        vad=ctx.proc.userdata["vad"],
        # Push-to-talk: the talk button commits each turn (see ``push_to_talk``
        # below), so the VAD must not end a turn on its own.
        turn_handling=PUSH_TO_TALK_TURNS if settings.push_to_talk else TURNS,
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

    async def close_without_a_model() -> None:
        # The tutor's model cannot answer any more: the student hears why, and
        # the platform records "provider_error", the end reason it accepts for
        # a service that failed, which the page's end screen explains.
        if platform and not platform.end_reason:
            platform.end_reason = "provider_error"
        try:
            await session.say(
                reply("tutor_unavailable", language),
                allow_interruptions=False,
                add_to_chat_ctx=False,
            )
        finally:
            session.shutdown()

    def model_unavailable() -> None:
        # In its own task, as the goodbye: the step that gave up ends at once.
        task = asyncio.create_task(close_without_a_model())
        asides.add(task)
        task.add_done_callback(asides.discard)

    tutor.on_unavailable = model_unavailable

    @session.on("conversation_item_added")
    def back_from_a_break(event) -> None:
        # Only a turn the gates let through is added. Its words are read for
        # tiredness, which makes the next break a calm one, and not kept.
        if getattr(event.item, "type", None) == "message" and event.item.role == "user":
            pace.student_spoke(tired=says_tired(event.item.text_content or ""))

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

    session_closed = asyncio.Event()

    @session.on("close")
    def closed(event: CloseEvent) -> None:
        nonlocal provider_failed
        provider_failed = event.error is not None
        session_closed.set()

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
        if settings.early_reply:
            logger.info("session early replies", extra=dict(tutor.early_replies))
        logger.info("session voice ahead", extra=dict(tutor.voiced_ahead))
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

    async def cleanup_then_last_events() -> None:
        try:
            await cleanup()
        finally:
            if observer is not None:
                # The session's own close runs beside this one, and the
                # requests it stops (a reply, a second reading) are reported
                # as they end: the last events go once it is done, or after a
                # while.
                with contextlib.suppress(TimeoutError):
                    async with asyncio.timeout(LAST_EVENTS_SECONDS):
                        await session_closed.wait()
                await observer.close()

    ctx.add_shutdown_callback(cleanup_then_last_events)

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
        # LiveKit would otherwise let anyone in the room drive the session:
        # send the model text that no gate reads, and read the tutor's
        # instructions, which hold the student's profile.
        session_host=False,
        record=False,
    )
    camera.start()
    # While the greeting is said: the first reply then reads its prompt from the cache.
    tasks.append(asyncio.create_task(tutor.warm_the_model()))

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
        await enable_push_to_talk(ctx, session, timing, tutor, gates)
    logger.info("session started", extra={"audience": audience, "language": language})


def main() -> None:
    # Checked here too so a misconfigured worker exits with one clear message
    # instead of registering and failing on its first session.
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    if command in {"start", "dev", "check"}:
        try:
            settings = Settings.from_env()
        except ConfigError as error:
            sys.exit(f"aule-agent: {error}")
        if not settings.gates_complete:
            logger.warning(
                "OPENAI_API_KEY and TYPESAFE_API_KEY are not both set: "
                "only operator sessions will be accepted"
            )
        if settings.posthog_problem:
            # Optional: the worker runs without it.
            logger.warning("AI observability is off: %s", settings.posthog_problem)
        if command == "check":
            # The start-up check alone, without joining LiveKit: it exits 0
            # only when a child's session could start now.
            logging.basicConfig(level=logging.INFO, format="%(levelname)s %(name)s: %(message)s")
            sys.exit(0 if asyncio.run(check_at_start(settings)) else 1)
    cli.run_app(server)


if __name__ == "__main__":
    main()
