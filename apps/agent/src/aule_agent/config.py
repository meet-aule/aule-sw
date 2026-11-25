"""Settings for the worker, read from the environment once at start.

A worker with a missing key would accept a session and then fail in front of
the user, so ``Settings.from_env`` reports every problem at once and the worker
refuses to start. AI observability is the exception: it is optional, so a
value that cannot be used turns it off and says why (``posthog_problem``).
"""

import os
import re
from collections.abc import Mapping
from dataclasses import dataclass, field

# The environment variable each provider's LiveKit plugin reads its key from.
STT_KEYS = {
    "assemblyai": "ASSEMBLYAI_API_KEY",
    "deepgram": "DEEPGRAM_API_KEY",
    "openai": "OPENAI_API_KEY",
}
TTS_KEYS = {
    "assemblyai": "ASSEMBLYAI_API_KEY",
    "cartesia": "CARTESIA_API_KEY",
    "elevenlabs": "ELEVEN_API_KEY",
    "inworld": "INWORLD_API_KEY",
    "openai": "OPENAI_API_KEY",
}
LLM_KEY = "ANTHROPIC_API_KEY"
# Each key turns its safety gate on (see ``safety``). There is no switch to turn
# a configured gate off.
MODERATION_KEY = "OPENAI_API_KEY"
PHYSICAL_SAFETY_KEY = "TYPESAFE_API_KEY"
LIVEKIT_KEYS = ("LIVEKIT_URL", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET")

LANGUAGES = ("es", "en")

# AI observability (``observability``) sends to PostHog's EU ingestion, where
# Aule's project is, with the project's token, which can only send events.
POSTHOG_HOST = "https://eu.i.posthog.com"
POSTHOG_TOKEN = re.compile(r"phc_[A-Za-z0-9]{20,100}")


class ConfigError(ValueError):
    """The environment cannot run a worker. The message lists every problem."""


def build_commit(env: Mapping[str, str] | None = None) -> str:
    """The commit the image was built from: ``AULE_COMMIT``, a build argument,
    when it is a commit's hex digits, and "unknown" otherwise."""
    env = os.environ if env is None else env
    commit = env.get("AULE_COMMIT", "").strip()
    return commit if re.fullmatch(r"[0-9a-f]{7,40}", commit) else "unknown"


@dataclass(frozen=True)
class Settings:
    agent_name: str
    stt: str
    tts: str
    tts_voice: str | None
    llm_model: str
    language: str
    session_max_minutes: int
    # Device turn-taking: the talk button drives turns, the VAD does not.
    push_to_talk: bool
    # How long a break lasts before the tutor asks to go on.
    break_minutes: int = 5
    # Where the notes of the moment (the supervisor's guidance, the engine's
    # rules for talk, then the output-language rule) go: after the
    # conversation, as a system message, on a model that takes one; otherwise
    # at the end of the system prompt.
    notes_after_history: bool = False
    # Whether the model is asked for a turn's reply while the input gates
    # still judge the turn. Nothing of the reply reaches the child before they
    # let it through; the child's words reach the model before they decide.
    early_reply: bool = False
    # Whether the voice is given a reply's first sentence while the output
    # gate judges the reply. Nothing of it is heard before the gate approves
    # it; the voice's provider gets the sentence before the gate decides.
    voice_ahead: bool = False
    # Whether TypeSafe's Jev reads a child's unsure words first and only a clear
    # "ordinary" from it is taken, the small model reading the rest as before
    # (opinion.py). Jev already reads every turn for the physical-safety gate.
    jev_first_reading: bool = False
    # Kept out of the repr so a logged Settings never shows a key.
    openai_api_key: str | None = field(default=None, repr=False)
    typesafe_api_key: str | None = field(default=None, repr=False)
    # Both set, or neither: AI observability is on only with both.
    posthog_api_key: str | None = field(default=None, repr=False)
    posthog_host: str | None = None
    # Why AI observability is off although a POSTHOG_ variable is set. It
    # names the variable and never shows its value.
    posthog_problem: str | None = None

    @property
    def gates_complete(self) -> bool:
        """Whether both safety gates are configured, which a child's session needs."""
        return bool(self.openai_api_key and self.typesafe_api_key)

    @classmethod
    def from_env(cls, env: Mapping[str, str] | None = None) -> "Settings":
        env = os.environ if env is None else env

        def get(name: str, default: str = "") -> str:
            return env.get(name, "").strip() or default

        problems: list[str] = []

        stt = get("AULE_STT").lower()
        if stt not in STT_KEYS:
            problems.append(f"AULE_STT must be one of: {', '.join(STT_KEYS)}")
        tts = get("AULE_TTS").lower()
        if tts not in TTS_KEYS:
            problems.append(f"AULE_TTS must be one of: {', '.join(TTS_KEYS)}")

        required = [*LIVEKIT_KEYS, LLM_KEY]
        if stt in STT_KEYS:
            required.append(STT_KEYS[stt])
        if tts in TTS_KEYS:
            required.append(TTS_KEYS[tts])
        for name in dict.fromkeys(required):
            if not get(name):
                problems.append(f"{name} is not set")

        # A gate key is sent in a header; one with a space or a line break in it
        # is a paste error that would only show up as a gate that never answers.
        for name in (MODERATION_KEY, PHYSICAL_SAFETY_KEY):
            if any(char.isspace() or not char.isprintable() for char in get(name)):
                problems.append(f"{name} must not contain spaces or control characters")

        language = get("AULE_LANGUAGE", "es").lower()
        if language not in LANGUAGES:
            problems.append(f"AULE_LANGUAGE must be one of: {', '.join(LANGUAGES)}")

        raw_minutes = get("AULE_SESSION_MAX_MINUTES", "15")
        minutes = int(raw_minutes) if raw_minutes.isdecimal() else 0
        if not 1 <= minutes <= 120:
            problems.append("AULE_SESSION_MAX_MINUTES must be a whole number from 1 to 120")

        raw_break = get("AULE_BREAK_MINUTES", "5")
        break_minutes = int(raw_break) if raw_break.isdecimal() else 0
        if not 1 <= break_minutes <= 15:
            problems.append("AULE_BREAK_MINUTES must be a whole number from 1 to 15")

        push_to_talk = get("AULE_PUSH_TO_TALK").lower() in ("1", "true", "yes", "on")
        notes_after_history = get("AULE_NOTES_AFTER_HISTORY").lower() in ("1", "true", "yes", "on")
        early_reply = get("AULE_EARLY_REPLY").lower() in ("1", "true", "yes", "on")
        voice_ahead = get("AULE_VOICE_AHEAD").lower() in ("1", "true", "yes", "on")
        jev_first_reading = get("AULE_JEV_FIRST_READING").lower() in ("1", "true", "yes", "on")

        posthog_key, posthog_host, posthog_problem = _posthog(
            get("POSTHOG_API_KEY"), get("POSTHOG_HOST")
        )

        if problems:
            raise ConfigError("; ".join(problems))

        return cls(
            agent_name=get("AULE_AGENT_NAME", "aule-tutor"),
            stt=stt,
            tts=tts,
            tts_voice=get("AULE_TTS_VOICE") or None,
            llm_model=get("AULE_LLM_MODEL", "claude-sonnet-5-5"),
            language=language,
            session_max_minutes=minutes,
            push_to_talk=push_to_talk,
            break_minutes=break_minutes,
            notes_after_history=notes_after_history,
            early_reply=early_reply,
            voice_ahead=voice_ahead,
            jev_first_reading=jev_first_reading,
            openai_api_key=get(MODERATION_KEY) or None,
            typesafe_api_key=get(PHYSICAL_SAFETY_KEY) or None,
            posthog_api_key=posthog_key,
            posthog_host=posthog_host,
            posthog_problem=posthog_problem,
        )


def _posthog(key: str, host: str) -> tuple[str | None, str | None, str | None]:
    """The token and the host AI observability sends with, or why it is off.
    Off without a word when neither is set."""
    if not key and not host:
        return None, None, None
    if not POSTHOG_TOKEN.fullmatch(key):
        return None, None, "POSTHOG_API_KEY must be a PostHog project token (phc_...)"
    if host.rstrip("/") != POSTHOG_HOST:
        return None, None, f"POSTHOG_HOST must be {POSTHOG_HOST}"
    return key, POSTHOG_HOST, None
