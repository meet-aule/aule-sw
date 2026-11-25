"""The tutor's model calls, and the safety second reader's readings of the
tutor's replies, as PostHog AI events, and the stages of each push-to-talk
turn the model answered: counts, times, the model's name and a random id per
turn. No words are sent, and no id of a person or a session, but which events
a turn has, and when, can still tell something about it, such as that a
safety gate stopped it (the agent's README says what).

Nothing is sent unless POSTHOG_API_KEY and POSTHOG_HOST are both set, to a
project token and PostHog's EU ingestion (``config``). The events are
pseudonymous: the model calls of one turn of the child share a random trace
id, and every event has its time, as Aule's own records of a session do.
There is no session id, no person, and no account, room or platform id; the
trace id is drawn at random for each turn and kept nowhere else. An allowlist
(``metadata_only``) runs on every event after the SDK has added its own
properties, and drops all of those.

The second reader's readings of what the child said are not sent: that one
happened, and how it went, would tell that moderation was unsure of a
child's words, and when. A turn the input gates stop asks the tutor's model
nothing, so it sends nothing either, not even its stages, but for a request
asked early (AULE_EARLY_REPLY).

Analytics never changes what the child hears or what a gate decides. Every
callback here catches its own errors and logs only their type, nothing on the
voice loop waits for the network, and a flush has a deadline.
"""

import asyncio
import contextlib
import contextvars
import logging
import math
import re
import threading
from typing import Any
from uuid import UUID, uuid4

from .config import Settings
from .providers import EARLY, WARMING
from .timing import STAGES

logger = logging.getLogger("aule.agent.observability")

# The random trace id of the turn whose model calls are being made (see
# ``new_turn``). Never derived from the room, the session, the platform's ids
# or the turn's number. A model call outside a turn, such as the warm-up, gets
# an id of its own.
TURN: contextvars.ContextVar[str | None] = contextvars.ContextVar("aule_turn", default=None)

GENERATION = "$ai_generation"
# One per staged push-to-talk turn the tutor's model answered, with what each
# stage took (``timing``).
TRACE = "$ai_trace"
TURN_NAME = "push_to_talk_turn"
DISTINCT_ID = "aule-agent"
TOKENS = (
    "$ai_input_tokens",
    "$ai_output_tokens",
    "$ai_cache_read_input_tokens",
    "$ai_cache_creation_input_tokens",
)
TIMES = ("$ai_latency", "$ai_time_to_first_token")
FLAGS = ("$ai_is_error", "$ai_stream", "aule_cancelled")
COMPONENTS = ("tutor", "safety_review")
# The tutor's requests: the one that writes the prompt cache while the
# greeting is said, one asked while the input gates still judge the turn
# (AULE_EARLY_REPLY), and the others.
REQUESTS = ("warm_up", "early", "turn")
STAGE_MS = tuple(f"aule_{stage}_ms" for stage in STAGES)
# Longer than this a stage is no measurement (a reply waits at most 30 s).
LONGEST_STAGE_MS = 600_000
# The stages only the tutor's model reports: its first chunk, and its first
# sentence or the start of a tool call. A tool call can start before the first
# chunk is read, and the line said while the tool works then closes the turn
# without it. A turn with neither stage got no reply from the model.
MODEL_STAGES = ("llm_ttft", "first_sentence")
# Every property an event may have when it leaves. PostHog moves the last one
# to the event's options.
ALLOWED = {
    GENERATION: frozenset(
        {
            "$ai_trace_id",
            "$ai_provider",
            "$ai_model",
            "$ai_cache_reporting_exclusive",
            *TOKENS,
            *TIMES,
            *FLAGS,
            "$ai_error",
            "aule_component",
            "aule_request",
            "$geoip_disable",
            "$process_person_profile",
        }
    ),
    TRACE: frozenset(
        {
            "$ai_trace_id",
            "$ai_span_name",
            "$ai_latency",
            *STAGE_MS,
            "$geoip_disable",
            "$process_person_profile",
        }
    ),
}

# PostHog's client: a small queue, short requests and no retries, so that a
# slow or missing PostHog costs these events and nothing else. No exception
# autocapture, feature flags or GeoIP.
CLIENT_OPTIONS: dict[str, Any] = {
    "privacy_mode": True,
    "enable_exception_autocapture": False,
    "enable_local_evaluation": False,
    "disable_geoip": True,
    "max_queue_size": 100,
    "flush_at": 20,
    "flush_interval": 2,
    "timeout": 1,
    "max_retries": 0,
}
# How long a flush waits for PostHog.
FLUSH_SECONDS = 2.0


def count(value: object) -> int:
    return value if type(value) is int and value >= 0 else 0


def number(value: object) -> bool:
    return type(value) in (int, float) and math.isfinite(value) and value >= 0


def model_name(value: object) -> str:
    return (
        value
        if isinstance(value, str)
        and re.fullmatch(r"claude-(?:sonnet|haiku|opus)-[0-9][0-9.-]{0,40}", value)
        else "unknown"
    )


def metadata_only(event: dict[str, Any]) -> dict[str, Any] | None:
    """The event as it may leave: the allowlist, run after the SDK has added
    its own properties (system, library, context tags, a session id), which
    it drops. Any other event, or one without a trace id, is dropped whole."""
    name = event.get("event")
    if name not in ALLOWED:
        return None
    source = event.get("properties") or {}
    try:
        trace = str(UUID(source["$ai_trace_id"]))
    except (KeyError, ValueError, TypeError, AttributeError):
        return None
    props: dict[str, Any] = {
        "$ai_trace_id": trace,
        "$geoip_disable": True,
        "$process_person_profile": False,
    }
    if name == TRACE:
        props["$ai_span_name"] = TURN_NAME
        if number(source.get("$ai_latency")):
            props["$ai_latency"] = source["$ai_latency"]
        for key in STAGE_MS:
            value = source.get(key)
            # Below zero too: the last final transcript can come before the release.
            if type(value) is int and abs(value) <= LONGEST_STAGE_MS:
                props[key] = value
    else:
        props["$ai_provider"] = "anthropic"
        props["$ai_model"] = model_name(source.get("$ai_model"))
        props["$ai_cache_reporting_exclusive"] = True
        for key in TOKENS:
            if type(source.get(key)) is int and source[key] >= 0:
                props[key] = source[key]
        for key in TIMES:
            if number(source.get(key)):
                props[key] = source[key]
        for key in FLAGS:
            if type(source.get(key)) is bool:
                props[key] = source[key]
        if source.get("aule_component") in COMPONENTS:
            props["aule_component"] = source["aule_component"]
        if source.get("aule_request") in REQUESTS:
            props["aule_request"] = source["aule_request"]
        if props.get("$ai_is_error"):
            props["$ai_error"] = "provider_error"
    return {
        "event": name,
        "distinct_id": DISTINCT_ID,
        "timestamp": event.get("timestamp"),
        "uuid": event.get("uuid"),
        "properties": props,
        "options": {"process_person_profile": False},
    }


def new_turn() -> str:
    """A turn of the child begins: the model calls made from here on, in this
    task and in the tasks it starts, share a new random trace id. Returns it."""
    trace = str(uuid4())
    TURN.set(trace)
    return trace


def _trace() -> str:
    return TURN.get() or str(uuid4())


def _request() -> str:
    """Which of the tutor's requests is being made (``providers``)."""
    if WARMING.get():
        return "warm_up"
    return "early" if EARLY.get() is not None else "turn"


def _dropped(error: BaseException) -> None:
    # The type only: a message may quote a request, and a request the child.
    logger.warning("AI observability event dropped", extra={"error": type(error).__name__})


def prewarm(settings: Settings) -> None:
    """Loads PostHog's client and has it work out what it adds to every event
    (the system's name and version, which on Linux reads files and may start
    a process, once) while the process waits for a session, so the first
    event does not pay for it on the voice loop. The allowlist drops all of
    it. Nothing is sent."""
    if not (settings.posthog_api_key and settings.posthog_host):
        return
    try:
        from posthog.utils import system_context

        system_context()
    except Exception as error:
        logger.warning("AI observability not warmed", extra={"error": type(error).__name__})


class Observability:
    """One session's events, sent by its own PostHog client."""

    def __init__(self, client: Any, *, model: str = "") -> None:
        self._client = client
        # The tutor's model, named on its failed requests.
        self._model = model_name(model)

    @classmethod
    def configured(cls, settings: Settings) -> "Observability | None":
        """The session's observability, or None when it is off."""
        if not (settings.posthog_api_key and settings.posthog_host):
            return None
        try:
            from posthog import Posthog

            client = Posthog(
                settings.posthog_api_key,
                host=settings.posthog_host,
                before_send=metadata_only,
                **CLIENT_OPTIONS,
            )
            return cls(client, model=settings.llm_model)
        except Exception as error:
            logger.warning(
                "AI observability could not start", extra={"error": type(error).__name__}
            )
            return None

    def _send(self, properties: dict[str, Any], event: str = GENERATION) -> None:
        self._client.capture(
            event,
            distinct_id=DISTINCT_ID,
            properties=properties,
            options={"process_person_profile": False},
        )

    def llm_metrics(self, metrics: object) -> None:
        """A request of the tutor's model ended (LiveKit's metrics_collected),
        whole or cut off."""
        try:
            request = _request()
            props: dict[str, Any] = {
                "$ai_trace_id": _trace(),
                "$ai_model": model_name(
                    getattr(getattr(metrics, "metadata", None), "model_name", None)
                ),
                "$ai_latency": getattr(metrics, "duration", None),
                "$ai_time_to_first_token": getattr(metrics, "ttft", None),
                # The warm-up is one request that is not streamed.
                "$ai_stream": request != "warm_up",
                "$ai_is_error": False,
                "aule_cancelled": getattr(metrics, "cancelled", False) is True,
                "aule_component": "tutor",
                "aule_request": request,
            }
            total = count(getattr(metrics, "prompt_tokens", None))
            output = count(getattr(metrics, "completion_tokens", None))
            # A request cut off before its end (a turn interrupted, an early
            # reply dropped) reports no usage at all. What it cost is not
            # known, which is not nothing: it has no token counts.
            if total or output:
                cached = count(getattr(metrics, "prompt_cached_tokens", None))
                written = count(getattr(metrics, "cache_creation_tokens", None))
                # LiveKit counts cache reads and writes in prompt_tokens; Anthropic,
                # and PostHog with $ai_cache_reporting_exclusive, keep them apart.
                props["$ai_input_tokens"] = max(0, total - cached - written)
                props["$ai_output_tokens"] = output
                props["$ai_cache_read_input_tokens"] = cached
                props["$ai_cache_creation_input_tokens"] = written
            self._send(props)
        except Exception as error:
            _dropped(error)

    def llm_error(self, error: object) -> None:
        """A request of the tutor's model failed (LiveKit's error event). One
        LiveKit retries is not a failed generation: what the retry does is
        reported instead. No message, request id or invented usage."""
        try:
            if getattr(error, "recoverable", False):
                return
            request = _request()
            self._send(
                {
                    "$ai_trace_id": _trace(),
                    "$ai_model": self._model,
                    "$ai_is_error": True,
                    "$ai_stream": request != "warm_up",
                    "aule_cancelled": False,
                    "aule_component": "tutor",
                    "aule_request": request,
                }
            )
        except Exception as failure:
            _dropped(failure)

    def review(
        self,
        usage: object,
        *,
        about: str,
        latency: float,
        failed: bool,
        model: str,
        cancelled: bool = False,
    ) -> None:
        """A reading of the second reader ended: answered, failed (an error
        or no answer in time), or cancelled (its turn ended). Only a reading
        of one of the tutor's replies (``about`` "reply") is sent; one of what
        the child said ("heard") is not, nor anything else. Its question and
        answer are not read."""
        if about != "reply":
            return
        try:
            props: dict[str, Any] = {
                "$ai_trace_id": _trace(),
                "$ai_model": model_name(model),
                "$ai_latency": latency,
                "$ai_is_error": failed and not cancelled,
                "$ai_stream": False,
                "aule_cancelled": cancelled,
                "aule_component": "safety_review",
            }
            if usage is not None and not cancelled:
                for name in (
                    "input_tokens",
                    "output_tokens",
                    "cache_read_input_tokens",
                    "cache_creation_input_tokens",
                ):
                    value = getattr(usage, name, None)
                    if type(value) is int and value >= 0:
                        props["$ai_" + name] = value
            self._send(props)
        except Exception as error:
            _dropped(error)

    def turn(self, trace: str | None, stages: dict[str, float]) -> None:
        """A staged push-to-talk turn closed at the tutor's first audio
        (``Timing.on_staged``): what each of its stages took, in whole
        milliseconds, under the trace id its model calls share. Only a turn
        the tutor's model answered is sent: the stages of one it did not, as
        when the input gates stop a turn, would say so. Whether its answer
        was checked is left for later."""
        if not any(stage in stages for stage in MODEL_STAGES):
            return
        try:
            props: dict[str, Any] = {"$ai_trace_id": trace or str(uuid4())}
            if number(stages.get("first_audio")):
                props["$ai_latency"] = stages["first_audio"]
            for stage, seconds in stages.items():
                if stage in STAGES and type(seconds) in (int, float) and math.isfinite(seconds):
                    props[f"aule_{stage}_ms"] = round(seconds * 1000)
            self._send(props, TRACE)
        except Exception as error:
            _dropped(error)

    async def close(self) -> None:
        """Sends what is queued, waiting for PostHog at most FLUSH_SECONDS, in
        a thread of its own: neither the voice loop nor the job's teardown
        waits longer. The client stays open, so an event that comes later is
        still taken, and sent by the next call or by the client's own timer.
        Never raises."""
        try:
            loop = asyncio.get_running_loop()
            done = asyncio.Event()

            def flush() -> None:
                try:
                    self._client.flush(timeout_seconds=FLUSH_SECONDS)
                except Exception as error:
                    logger.warning(
                        "AI observability flush failed", extra={"error": type(error).__name__}
                    )
                finally:
                    # The loop may be gone by now: nobody is waiting any more.
                    with contextlib.suppress(RuntimeError):
                        loop.call_soon_threadsafe(done.set)

            # A daemon thread: one stuck in a request never holds up the
            # process's exit.
            threading.Thread(target=flush, name="aule-observability-flush", daemon=True).start()
            async with asyncio.timeout(FLUSH_SECONDS + 0.5):
                await done.wait()
        except Exception as error:
            logger.warning(
                "AI observability flush incomplete", extra={"error": type(error).__name__}
            )
