"""Build the speech and language models a session uses from the settings.

Plugins are imported inside each branch so a worker only loads the providers
it is configured for. Each plugin reads its own key from the environment;
``config`` has already checked that it is there.
"""

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

    # Cache the stable prefix of each turn (the tutor's instructions and the
    # session context, which repeat every turn) so most input tokens are billed
    # once, not per turn. A guidance update rewrites the instructions and simply
    # re-primes the cache; the per-turn camera frame rides in the last user
    # message, so it never invalidates it.
    return TutorLLM(
        model=settings.llm_model,
        **({"client": client} if client is not None else {}),
        max_tokens=MAX_REPLY_TOKENS if spoken else MAX_TOKENS_WITH_THINKING,
        caching="ephemeral",
    )
