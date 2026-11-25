"""Build the speech and language models a session uses from the settings.

Plugins are imported inside each branch so a worker only loads the providers
it is configured for. Each plugin reads its own key from the environment;
``config`` has already checked that it is there.
"""

import contextvars
from dataclasses import dataclass
from typing import Any

from livekit.agents import llm, stt, tts

from .config import Settings

# Replies are spoken, so a long one is a bug: keep the model from producing it.
# The whole reply is generated before any of it is spoken (the output gate
# buffers it), so the ceiling also bounds the wait to the first word. It has to
# leave room for a full two-sentence reply: a reply cut by the ceiling is spoken
# cut.
MAX_REPLY_TOKENS = 300

# Models whose thinking is on by default and counts against ``max_tokens``. With
# a ceiling this low the thinking alone can use all of it and the reply comes
# back with no text at all, so the tutor says nothing. On these models thinking
# is limited to between tool calls, which also halves the time to the reply.
THINKS_BETWEEN_TOOLS = ("claude-sonnet-5-5",)
# Any other model keeps its own thinking and gets room for it.
MAX_TOKENS_WITH_THINKING = 1024

# Models that take a system message in the middle of the conversation
# (skill shared/prompt-caching.md; any other answers 400). On them, with
# AULE_NOTES_AFTER_HISTORY, what changes between turns can go there, after the
# cached history; otherwise it stays at the end of the system prompt.
SYSTEM_MESSAGES = ("claude-sonnet-5-5",)
EPHEMERAL = {"type": "ephemeral"}


@dataclass(frozen=True)
class Prompt:
    """What the tutor's model is told, from what changes least to what
    changes most: the rules (how to teach, the screen, the checking tools),
    the student's own part (what is known of them, the plan, the tone), and
    the notes of the moment (the supervisor's guidance, the engine's rules
    for talk, and after them the output-language rule, the last instruction
    of every request), which may change between any two turns."""

    rules: str
    student: str = ""
    notes: str = ""

    @property
    def system(self) -> str:
        """The rules and the student's part as one text: what the cache keeps."""
        student = self.student.strip()
        return f"{self.rules}\n\n{student}" if student else self.rules

    @property
    def text(self) -> str:
        """All of it as one text, in that order: the instructions as the
        tutor holds them and LiveKit hands them to the plugin."""
        notes = self.notes.strip()
        return f"{self.system}\n\n{notes}" if notes else self.system


# The prompt of the request being made. The tutor sets it before it asks the
# model; the plugin's stream task, created then, inherits it.
REQUEST: contextvars.ContextVar[Prompt | None] = contextvars.ContextVar(
    "aule_request", default=None
)
# Set while the tutor warms the prompt cache (``PromptLayout``).
WARMING: contextvars.ContextVar[bool] = contextvars.ContextVar("aule_warming", default=False)


def _plain(block: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in block.items() if key != "cache_control"}


def _marked(block: dict[str, Any]) -> dict[str, Any]:
    return {**block, "cache_control": EPHEMERAL}


def layout(
    request: dict[str, Any],
    prompt: Prompt | None,
    previous: list[dict[str, Any]] | None = None,
    *,
    system_messages: bool,
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """The request as it is sent, laid out for the prompt cache, and its
    messages as the next request will find them.

    The cache is a prefix match over tools, system and messages, in that
    order (skill shared/prompt-caching.md). So the tools come first,
    unchanged and unmarked. The instructions, when they are the prompt's
    text, become two system blocks, the rules and the student's part, each
    marked: the rules are the same for every session of their kind, the
    student's part for the whole session but for a late plan. The history
    only grows: a marker on the last block of the newest message from the
    user's side writes it, and one on the message that ended the previous
    request reads it back. The notes, which end the instructions, are read
    fresh for each request and sent last, unmarked and not kept: a last
    system block, where they always were, or with ``system_messages`` a
    system message after the history, which a change of them then leaves
    cached too. Either way nothing comes after them, so the output-language
    rule that ends them stays the last instruction. Instructions that are
    not the prompt's text go as they are, marked at their end. ``tool_choice``
    is the same on every call, as a change of it would drop the cached
    history. At most four markers.
    """
    out = dict(request)
    messages = [
        {
            "role": message["role"],
            "content": (
                [{"type": "text", "text": content}]
                if isinstance(content := message["content"], str)
                else [_plain(block) for block in content]
            ),
        }
        for message in request.get("messages") or []
    ]
    kept = [dict(message, content=list(message["content"])) for message in messages]

    system = [_plain(block) for block in request.get("system") or []]
    notes = ""
    if prompt is not None and [block.get("text") for block in system] == [prompt.text]:
        system = [{"type": "text", "text": prompt.rules}]
        if prompt.student.strip():
            system.append({"type": "text", "text": prompt.student.strip()})
        system = [_marked(block) for block in system]
        notes = prompt.notes.strip()
    elif system:
        # Not the tutor's prompt: sent whole, its notes (if any) in it.
        system[-1] = _marked(system[-1])

    users = [index for index, message in enumerate(messages) if message["role"] == "user"]
    if users:
        newest = messages[users[-1]]["content"]
        # Not on a camera frame: it rides in this turn only, and the next
        # request would not find the history it is part of.
        texts = [index for index, block in enumerate(newest) if block.get("type") != "image"]
        if texts:
            newest[texts[-1]] = _marked(newest[texts[-1]])
    if previous and len(previous) <= len(kept) and kept[: len(previous)] == previous:
        end = len(previous) - 1
        if not users or end != users[-1]:
            ending = messages[end]["content"]
            ending[-1] = _marked(ending[-1])

    if notes and system_messages and messages and messages[-1]["role"] == "user":
        messages.append({"role": "system", "content": notes})
    elif notes:
        system.append({"type": "text", "text": notes})

    if system:
        out["system"] = system
    out["messages"] = messages
    if out.get("tools") and not out.get("tool_choice"):
        out["tool_choice"] = {"type": "auto"}
    return out, kept


class PromptLayout:
    """The Anthropic client the model's plugin calls, with each request laid
    out by ``layout`` just before it is sent. Everything else, the transport
    included, is the plugin's own client."""

    def __init__(self, client: Any, model: str, *, notes_after_history: bool = False) -> None:
        self._client = client
        self._system_messages = notes_after_history and model.startswith(SYSTEM_MESSAGES)
        self._previous: list[dict[str, Any]] | None = None
        self.messages = _Messages(self)

    def __getattr__(self, name: str) -> Any:
        return getattr(self._client, name)

    async def create(self, **request: Any) -> Any:
        if WARMING.get():
            return await self._warm(request)
        sent, self._previous = layout(
            request, REQUEST.get(), self._previous, system_messages=self._system_messages
        )
        return await self._client.messages.create(**sent)

    async def _warm(self, request: dict[str, Any]) -> Any:
        """Writes the cache up to the system blocks, and nothing else: the
        request the plugin built, sent once without streaming and with
        max_tokens 0, so the model writes no word (skill
        shared/prompt-caching.md, "Pre-warming the cache"; streaming is
        refused with max_tokens 0). Tools, system, thinking and tool_choice
        are a real call's; the placeholder message is unmarked, and the
        notes follow it when they go after the history, as a reply's do."""
        sent, _ = layout(request, REQUEST.get(), system_messages=self._system_messages)
        sent["messages"] = [
            {"role": message["role"], "content": [_plain(block) for block in content]}
            if isinstance(content := message["content"], list)
            else message
            for message in sent["messages"]
        ]
        sent["stream"] = False
        sent["max_tokens"] = 0
        return _Prefilled(await self._client.messages.create(**sent))


class _Prefilled:
    """The warm-up's answer as the plugin reads a stream: its usage only."""

    def __init__(self, answer: Any) -> None:
        from anthropic.types import RawMessageStartEvent

        self._events = [RawMessageStartEvent(type="message_start", message=answer)]

    async def __aenter__(self) -> "_Prefilled":
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    def __aiter__(self) -> "_Prefilled":
        return self

    async def __anext__(self) -> Any:
        if not self._events:
            raise StopAsyncIteration
        return self._events.pop(0)


class _Messages:
    def __init__(self, client: PromptLayout) -> None:
        self.create = client.create


def build_stt(settings: Settings, language: str) -> stt.STT:
    if settings.stt == "assemblyai":
        from livekit.plugins import assemblyai

        return assemblyai.STT(language_code=language)
    if settings.stt == "deepgram":
        from livekit.plugins import deepgram

        # Children's voices: not kept to train Deepgram's models (no change in
        # price for pay-as-you-go, per Deepgram's changelog of 2026-03-05).
        return deepgram.STT(language=language, mip_opt_out=True)
    from livekit.plugins import openai

    return openai.STT(language=language)


def build_tts(settings: Settings, language: str) -> tts.TTS:
    voice = settings.tts_voice
    if settings.tts == "assemblyai":
        from livekit.plugins import assemblyai

        # Every assemblyai-tts-1 voice can speak each language, but a voice sounds
        # best in its own, so pick a voice recorded in the language (an ``aai-``
        # slug, e.g. ``aai-constanza`` for Spanish) via AULE_TTS_VOICE. The
        # plugin takes an ISO code for ``language``. Without a voice the model
        # falls back to the language's default, which may be another language.
        return assemblyai.TTS(language=language, **({"voice": voice} if voice else {}))
    if settings.tts == "cartesia":
        from livekit.plugins import cartesia

        return cartesia.TTS(language=language, **({"voice": voice} if voice else {}))
    if settings.tts == "elevenlabs":
        from livekit.plugins import elevenlabs

        return elevenlabs.TTS(language=language, **({"voice_id": voice} if voice else {}))
    if settings.tts == "inworld":
        from livekit.plugins import inworld

        # Inworld wants a BCP-47 tag; the app's language is a bare code.
        bcp47 = {"es": "es-ES", "en": "en-US"}.get(language, language)
        return inworld.TTS(language=bcp47, **({"voice": voice} if voice else {}))
    from livekit.plugins import openai

    return openai.TTS(**({"voice": voice} if voice else {}))


def build_llm(settings: Settings, *, client: Any = None) -> llm.LLM:
    from livekit.plugins import anthropic

    spoken = settings.llm_model.startswith(THINKS_BETWEEN_TOOLS)

    class TutorLLM(anthropic.LLM):
        def chat(self, **kwargs: Any) -> llm.LLMStream:
            if spoken:
                given = kwargs.get("extra_kwargs")
                extra = dict(given) if isinstance(given, dict) else {}
                extra.setdefault("thinking", {"type": "between_tools"})
                kwargs["extra_kwargs"] = extra
            return super().chat(**kwargs)

    # The prompt cache's markers are placed by ``layout``, not by the plugin,
    # around the client the model is given or else the plugin's own.
    model = TutorLLM(
        model=settings.llm_model,
        **({"client": client} if client is not None else {}),
        max_tokens=MAX_REPLY_TOKENS if spoken else MAX_TOKENS_WITH_THINKING,
    )
    # The tutoring evaluation (evals/pedagogy) names the model and nothing else.
    notes_after_history = getattr(settings, "notes_after_history", False)
    model._client = PromptLayout(
        model._client, settings.llm_model, notes_after_history=notes_after_history
    )
    return model
