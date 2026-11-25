"""PostHog generations from counts only, with no conversation or account identifiers."""

import asyncio
import logging
import math
import re
from typing import Any
from uuid import UUID, uuid4

from .config import Settings

logger = logging.getLogger("aule.agent.observability")

COUNTS = {
    "$ai_input_tokens",
    "$ai_output_tokens",
    "$ai_cache_read_input_tokens",
    "$ai_cache_creation_input_tokens",
}
TIMES = {"$ai_latency", "$ai_time_to_first_token"}
IDS = {"$ai_session_id", "$ai_trace_id"}
ROLES = {"tutor", "safety_review"}


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
    """An allowlist after SDK enrichment; context tags cannot add personal data."""
    if event.get("event") != "$ai_generation":
        return None
    source = event.get("properties", {})
    props: dict[str, Any] = {
        "$ai_provider": "anthropic",
        "$ai_model": model_name(source.get("$ai_model")),
        "$geoip_disable": True,
        "$process_person_profile": False,
        "$ai_cache_reporting_exclusive": True,
    }
    for key in COUNTS:
        if type(source.get(key)) is int and source[key] >= 0:
            props[key] = source[key]
    for key in TIMES:
        if number(source.get(key)):
            props[key] = source[key]
    for key in IDS:
        try:
            props[key] = str(UUID(source[key]))
        except (KeyError, ValueError, TypeError, AttributeError):
            return None
    for key in ("$ai_is_error", "$ai_stream", "aule_cancelled"):
        if type(source.get(key)) is bool:
            props[key] = source[key]
    if source.get("aule_component") in ROLES:
        props["aule_component"] = source["aule_component"]
    if props.get("$ai_is_error"):
        props["$ai_error"] = "provider_error"
    return {
        "event": "$ai_generation",
        "distinct_id": "aule-agent",
        "timestamp": event.get("timestamp"),
        "uuid": event.get("uuid"),
        "properties": props,
        "options": {"process_person_profile": False},
    }


class Observability:
    def __init__(self, client: Any) -> None:
        self._client = client
        # Never derived from a child, account, room, device or platform session.
        self._session = str(uuid4())
        self._closed = False

    @classmethod
    def configured(cls, settings: Settings) -> "Observability | None":
        if not settings.posthog_api_key:
            return None
        try:
            from posthog import Posthog

            return cls(
                Posthog(
                    settings.posthog_api_key,
                    host=settings.posthog_host,
                    privacy_mode=True,
                    before_send=metadata_only,
                    enable_exception_autocapture=False,
                    enable_local_evaluation=False,
                    disable_geoip=True,
                    max_queue_size=100,
                    flush_at=20,
                    flush_interval=2,
                    timeout=1,
                    max_retries=0,
                )
            )
        except Exception:
            logger.warning("AI observability could not start")
            return None

    def _send(self, properties: dict[str, Any]) -> None:
        if self._closed:
            return
        try:
            self._client.capture(
                "$ai_generation",
                distinct_id="aule-agent",
                properties={
                    **properties,
                    "$ai_session_id": self._session,
                    "$ai_trace_id": str(uuid4()),
                },
                options={"process_person_profile": False},
            )
        except Exception:
            # Analytics must never prevent a reply or change a safety decision.
            logger.warning("AI observability event not queued")

    def llm_metrics(self, metrics: object) -> None:
        cached = count(getattr(metrics, "prompt_cached_tokens", None))
        written = count(getattr(metrics, "cache_creation_tokens", None))
        # LiveKit includes cache reads and writes in prompt_tokens; Anthropic
        # and PostHog's exclusive cache accounting keep them separate.
        total = count(getattr(metrics, "prompt_tokens", None))
        props: dict[str, Any] = {
            "$ai_model": model_name(
                getattr(getattr(metrics, "metadata", None), "model_name", None)
            ),
            "$ai_input_tokens": max(0, total - cached - written),
            "$ai_output_tokens": count(getattr(metrics, "completion_tokens", None)),
            "$ai_cache_read_input_tokens": cached,
            "$ai_cache_creation_input_tokens": written,
            "$ai_latency": getattr(metrics, "duration", None),
            "$ai_time_to_first_token": getattr(metrics, "ttft", None),
            "$ai_stream": True,
            "$ai_is_error": False,
            "aule_cancelled": bool(getattr(metrics, "cancelled", False)),
            "aule_component": "tutor",
        }
        self._send(props)

    def llm_error(self, _: object) -> None:
        # No exception message, request body, request ID or invented zero cost.
        self._send({"$ai_is_error": True, "$ai_stream": True, "aule_component": "tutor"})

    def review(self, usage: object, latency: float, failed: bool, model: str) -> None:
        props: dict[str, Any] = {
            "$ai_model": model_name(model),
            "$ai_latency": latency,
            "$ai_is_error": failed,
            "$ai_stream": False,
            "aule_component": "safety_review",
        }
        if usage is not None:
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

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            # A job has its own process and client. Drain off the voice event loop.
            await asyncio.wait_for(asyncio.to_thread(self._client.shutdown), timeout=5)
        except Exception:
            logger.warning("AI observability shutdown incomplete")
