"""Stand-ins for every paid provider a tutor session uses, with delays drawn
from configurable distributions: the hearing and its voice detector, the
voice, the tutor's model and the second reader, content moderation, the
physical-safety gate and the platform. Nothing here opens a connection
(``no_network`` makes sure of it), and nothing calls a paid service.

One ``World`` holds the stand-ins of one session and records what each was
asked and what reached the child: every frame played, every word shown.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import hashlib
import json
import math
import random
import re
import socket
import time
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator
from dataclasses import dataclass, field
from types import SimpleNamespace
from typing import Any

import anthropic
import httpx2
import numpy as np
from anthropic import types as wire
from livekit import rtc
from livekit.agents import APIConnectOptions, stt, tokenize, tts, utils, vad
from livekit.agents.language import LanguageCode
from livekit.agents.types import DEFAULT_API_CONNECT_OPTIONS
from livekit.agents.voice import io

from aule_agent.moderation import THRESHOLDS
from aule_agent.physical_safety import MODEL as TYPESAFE_MODEL

# The world of the session being set up or driven: what the stand-ins built
# by patched constructors belong to.
CURRENT_WORLD: contextvars.ContextVar[World] = contextvars.ContextVar("current_world")

# Words that make a stand-in answer one way. They are synthetic: no real
# sentence of a child carries them.
TRIGGERS = {
    "violence": "TRIGGER_VIOLENCE",
    "self_harm": "TRIGGER_SELF_HARM",
    "minors": "TRIGGER_MINORS",
    "faint": "TRIGGER_FAINT",
    "unsure_score": "TRIGGER_UNSURE_SCORE",
    "hazard": "TRIGGER_HAZARD",
    "unsure": "TRIGGER_UNSURE",
    "concern": "TRIGGER_CONCERN",
    "moderation_down": "TRIGGER_MODERATION_DOWN",
    "moderation_slow": "TRIGGER_MODERATION_SLOW",
    "typesafe_down": "TRIGGER_TYPESAFE_DOWN",
    "reader_slow": "TRIGGER_READER_SLOW",
}

# What the child says in every turn, so that its absence from the logs and
# from anything kept can be checked.
CHILD_WORDS = "zanahoria azul siete"

# Characters per token, for the prompt sizes the model stand-in bills.
CHARS_PER_TOKEN = 3.0


@dataclass(frozen=True)
class Spread:
    """A delay drawn from a lognormal with this median and 90th percentile."""

    median: float
    p90: float

    def draw(self, rng: random.Random, scale: float = 1.0) -> float:
        if self.median <= 0:
            return 0.0
        sigma = math.log(self.p90 / self.median) / 1.2816 if self.p90 > self.median else 0.0
        return scale * self.median * math.exp(rng.gauss(0.0, sigma))


@dataclass(frozen=True)
class Delays:
    """How long each stand-in takes. ``scale`` shrinks every provider delay
    (tests use a small one); LiveKit's own timers are never scaled."""

    scale: float = 1.0
    # Mic off plus the RPC's trip, for each RPC the page sends.
    transit: Spread = Spread(0.05, 0.10)
    # Deepgram: a final transcript after the end of speech (STT bench).
    final_after_speech: Spread = Spread(0.12, 0.23)
    # OpenAI moderation, plus TCP and TLS on a connection that is not kept.
    moderation: Spread = Spread(0.18, 0.35)
    new_connection: Spread = Spread(0.10, 0.25)
    # TypeSafe: about 80 ms (physical_safety.py).
    typesafe: Spread = Spread(0.08, 0.15)
    second_reader: Spread = Spread(0.8, 1.6)
    platform: Spread = Spread(0.05, 0.15)
    # The tutor's model: time to the first token with nothing to read, then
    # what each thousand tokens of uncached input adds.
    first_token: Spread = Spread(0.62, 0.95)
    per_1k_uncached: float = 0.035
    tokens_per_second: tuple[float, float] = (55.0, 90.0)
    # A request of max_tokens 0: prefill only.
    prefill: Spread = Spread(0.15, 0.3)
    # AssemblyAI: text sent to the first audio of a sentence.
    voice_first_audio: Spread = Spread(0.28, 0.45)
    # How long each client keeps an idle connection.
    moderation_keepalive: float = 5.0
    typesafe_keepalive: float = 15.0
    reader_keepalive: float = 5.0
    model_keepalive: float = 120.0
    # How fast the fake speaker plays: frames reach the room faster than real time.
    playout_speed: float = 10.0
    # The voice detector reports the end of speech after this much silence
    # (silero's default) and the start after this much speech.
    vad_silence: float = 0.55
    vad_min_speech: float = 0.12
    # The hearing hears shorter speech than the voice detector, and says that
    # speech started this long after it did.
    stt_min_speech: float = 0.05
    stt_start_after: float = 0.1

    def scaled(self, spread: Spread, rng: random.Random) -> float:
        return spread.draw(rng, self.scale)


class Connections:
    """The idle connections of one HTTP client and how long each is kept."""

    def __init__(self, keepalive: float) -> None:
        self._keepalive = keepalive
        self._idle: list[float] = []

    def take(self) -> bool:
        """True when an idle connection was there to reuse."""
        now = time.monotonic()
        self._idle = [at for at in self._idle if now - at <= self._keepalive]
        if self._idle:
            self._idle.pop()
            return True
        return False

    def give_back(self) -> None:
        self._idle.append(time.monotonic())


# --- The world of one session ---------------------------------------------


@dataclass
class Played:
    """One stretch of audio the speaker started playing."""

    started_at: float
    texts: list[str] = field(default_factory=list)
    interrupted: bool = False


@dataclass
class ModelCall:
    """One request to the tutor's model."""

    kwargs: dict[str, Any]
    opened_at: float
    first_token_at: float | None = None
    finished_at: float | None = None
    closed: bool = False
    output_text: str = ""
    tool_calls: list[str] = field(default_factory=list)
    # When the first tool call began, and the type of every event sent.
    tool_started_at: float | None = None
    events: list[str] = field(default_factory=list)
    # Whether the response began with a thinking block.
    thought: bool = False
    cache_read: int = 0
    cache_write: int = 0
    uncached: int = 0


@dataclass
class TurnPlan:
    """What the model stand-in answers to one turn of the child."""

    reply: str
    tool: str | None = None
    tool_tokens: int = 0
    reply_after_tool: str = ""
    # Text the model writes before a tool call, which is never said.
    preamble: str = ""
    # Tools called in further steps of the same turn, before the reply.
    more_tools: tuple[str, ...] = ()


class World:
    """The stand-ins of one session and everything they saw."""

    def __init__(self, *, seed: int, delays: Delays, mix: str = "free") -> None:
        self.seed = seed
        self.rng = random.Random(seed)
        self.delays = delays
        self.mix = mix
        self.events: list[tuple[float, str]] = []
        self.played: list[Played] = []
        self.shown: list[tuple[float, str]] = []
        self.voice_texts: dict[int, str] = {}
        # Each sentence the voice was given, and when its audio was made.
        self.voiced: list[tuple[float, str]] = []
        self.made: list[tuple[float, str]] = []
        self.model_calls: list[ModelCall] = []
        self.reader_calls: list[tuple[float, str]] = []
        self.api_errors: list[str] = []
        self.plans: dict[str, TurnPlan] = {}
        self.moderated: list[str] = []
        self.typesafe_asked: list[str] = []
        # Requests that only open a connection (lists of models), by client.
        self.warmups = {"typesafe": 0, "reader": 0, "model": 0}
        self.platform_calls: list[tuple[str, str, Any]] = []
        self.flags: list[tuple[str, str, list[str]]] = []
        self.reported_turns: list[dict[str, Any]] = []
        self.metrics: dict[str, float] = {}
        # When the input gates decided each turn (and whether it passed), every
        # text the output gate approved, and when it decided on each.
        self.decided: list[tuple[float, bool]] = []
        self.approved: list[str] = []
        self.judged: list[tuple[float, str, bool]] = []
        self.cache = PromptCache()
        # When the model stand-in begins a response with a thinking block:
        # "between_tools" (after a tool's result, as thinking between tools
        # does), "always" or "never".
        self.thinking = "between_tools"
        # Awaited with each request to the tutor's model before it answers:
        # it may raise what the API answers instead (``refusal``) or never
        # return, as a request that hangs.
        self.model_trouble: Callable[[dict[str, Any]], Awaitable[None]] | None = None
        self.speaker = Speaker(self)
        self.stt = FakeSTT(self)
        self.vad = FakeVAD(self)
        self.voice = FakeVoice(self)
        self.model_client = FakeAnthropic(self, role="model")
        self.reader_client = FakeAnthropic(self, role="reader")
        self.moderation_client = FakeModeration(self)
        self.typesafe = FakeTypeSafe(self)
        self.platform = FakePlatform(self)
        self.session: Any = None
        self.tutor: Any = None
        self.rpcs: dict[str, Any] = {}

    def mark(self, what: str) -> None:
        self.events.append((time.time(), what))

    def marker_for(self, text: str) -> int:
        marker = len(self.voice_texts) + 1
        self.voice_texts[marker] = text
        return marker


# --- What the child says: the voice detector and the hearing ---------------


class FakeVADStream(vad.VADStream):
    def __init__(self, detector: FakeVAD) -> None:
        super().__init__(detector)

    async def _main_task(self) -> None:
        async for _ in self._input_ch:
            pass

    def emit(self, event: vad.VADEvent) -> None:
        if not self._event_ch.closed:
            self._event_ch.send_nowait(event)


class FakeVAD(vad.VAD):
    def __init__(self, world: World) -> None:
        super().__init__(capabilities=vad.VADCapabilities(update_interval=0.1))
        self._world = world

    def stream(self) -> FakeVADStream:
        stream = FakeVADStream(self)
        self._world.speaker.vad_streams.append(stream)
        return stream


class FakeRecognizeStream(stt.RecognizeStream):
    def __init__(self, hearing: FakeSTT, conn_options: APIConnectOptions) -> None:
        super().__init__(stt=hearing, conn_options=conn_options)

    async def _run(self) -> None:
        async for _ in self._input_ch:
            pass

    @property
    def open(self) -> bool:
        return not self._event_ch.closed

    def emit(self, event: stt.SpeechEvent) -> None:
        if not self._event_ch.closed:
            self._event_ch.send_nowait(event)


class FakeSTT(stt.STT):
    """The hearing: it sends what the speaker script says, when it says it."""

    def __init__(self, world: World) -> None:
        super().__init__(capabilities=stt.STTCapabilities(streaming=True, interim_results=True))
        self._world = world
        self.streams: list[FakeRecognizeStream] = []

    async def _recognize_impl(self, buffer: Any, **options: Any) -> stt.SpeechEvent:
        raise NotImplementedError

    def stream(self, **options: Any) -> FakeRecognizeStream:
        stream = FakeRecognizeStream(self, options.get("conn_options", DEFAULT_API_CONNECT_OPTIONS))
        self.streams.append(stream)
        return stream


def _speech(kind: stt.SpeechEventType, text: str = "") -> stt.SpeechEvent:
    alternatives = (
        [stt.SpeechData(language=LanguageCode("es"), text=text, confidence=0.92)] if text else []
    )
    return stt.SpeechEvent(type=kind, alternatives=alternatives)


@dataclass
class _Utterance:
    """Words said into the microphone, and the events that report them, each
    with the moment of speech it reports."""

    words: str
    start: float
    end: float
    final_delay: float | None
    vad: bool
    events: list[tuple[float, asyncio.TimerHandle]] = field(default_factory=list)


class Speaker:
    """The child: speaks into the microphone while the button is held."""

    def __init__(self, world: World) -> None:
        self._world = world
        self.vad_streams: list[FakeVADStream] = []
        self._timers: list[asyncio.TimerHandle] = []
        self._said: list[_Utterance] = []
        self.muted_at: float | None = None

    def _hearing(self) -> FakeRecognizeStream | None:
        streams = [stream for stream in self._world.stt.streams if stream.open]
        return streams[-1] if streams else None

    def _vad(self, event: vad.VADEvent) -> None:
        if self.vad_streams:
            self.vad_streams[-1].emit(event)

    def _stt(self, event: stt.SpeechEvent) -> None:
        if (stream := self._hearing()) is not None:
            stream.emit(event)

    def _at(self, at: float, action: Any, said: _Utterance, heard: float) -> None:
        loop = asyncio.get_running_loop()
        timer = loop.call_at(loop.time() + max(0.0, at - time.time()), action)
        self._timers.append(timer)
        said.events.append((heard, timer))

    def say(
        self,
        words: str,
        start: float,
        end: float,
        *,
        final_delay: float | None,
        vad: bool = True,
    ) -> None:
        """Speaks ``words`` from ``start`` to ``end`` (wall clock). The voice
        detector and the hearing report it as a microphone would let them:
        nothing of what is said after the microphone goes off, also when it
        goes off while the words are said (``mute``). Words too soft for the
        voice detector (``vad`` False) reach the hearing only. With no
        ``final_delay`` the hearing never finalizes it: only interims come."""
        if self.muted_at is not None:
            end = min(end, self.muted_at)
        said = _Utterance(words, start, end, final_delay, vad)
        self._said.append(said)
        self._report(said, words, start, end)

    def _report(self, said: _Utterance, words: str, start: float, end: float) -> None:
        delays = self._world.delays
        duration = end - start

        def vad_event(kind: vad.VADEventType, **fields: Any) -> vad.VADEvent:
            return vad.VADEvent(
                type=kind,
                samples_index=0,
                timestamp=time.time(),
                speech_duration=fields.pop("speech_duration", 0.0),
                silence_duration=fields.pop("silence_duration", 0.0),
                **fields,
            )

        if said.vad and duration >= delays.vad_min_speech:
            heard = start + delays.vad_min_speech
            self._at(
                heard,
                lambda: self._vad(
                    vad_event(
                        vad.VADEventType.START_OF_SPEECH, speech_duration=delays.vad_min_speech
                    )
                ),
                said,
                heard,
            )
            tick = start + 0.1
            while tick < end:
                self._at(
                    tick,
                    lambda: self._vad(
                        vad_event(
                            vad.VADEventType.INFERENCE_DONE,
                            speaking=True,
                            raw_accumulated_speech=0.1,
                            probability=0.9,
                        )
                    ),
                    said,
                    tick,
                )
                tick += 0.1
            self._at(
                end + delays.vad_silence,
                lambda: self._vad(
                    vad_event(
                        vad.VADEventType.END_OF_SPEECH,
                        speech_duration=duration,
                        silence_duration=delays.vad_silence,
                    )
                ),
                said,
                end,
            )
        if duration < delays.stt_min_speech:
            return
        self._at(
            start + delays.stt_start_after,
            lambda: self._stt(_speech(stt.SpeechEventType.START_OF_SPEECH)),
            said,
            start,
        )
        spoken = words.split()
        for step in range(1, 4):
            at = start + duration * step / 4
            partial = " ".join(spoken[: max(1, len(spoken) * step // 4)])
            self._at(at, lambda partial=partial: self._stt(_interim(partial)), said, at)
        if said.final_delay is not None:
            self._at(
                end + said.final_delay,
                lambda: self._stt(_speech(stt.SpeechEventType.FINAL_TRANSCRIPT, words)),
                said,
                end,
            )
            self._at(
                end + said.final_delay + 0.01,
                lambda: self._stt(_speech(stt.SpeechEventType.END_OF_SPEECH)),
                said,
                end,
            )

    def unmute(self) -> None:
        self.muted_at = None

    def mute(self) -> None:
        """The microphone goes off: words being said are cut where they are,
        and the events that would report what came after are not sent."""
        now = self.muted_at = time.time()
        for said in self._said:
            if said.start >= now:
                # Not begun yet: none of it is heard.
                for _, timer in said.events:
                    timer.cancel()
                said.events = []
                continue
            if now >= said.end:
                continue
            kept = []
            for heard, timer in said.events:
                if heard > now:
                    timer.cancel()
                else:
                    kept.append((heard, timer))
            said.events = kept
            spoken = said.words.split()
            share = (now - said.start) / (said.end - said.start)
            words = " ".join(spoken[: max(1, round(len(spoken) * share))])
            # What was heard of them, reported as words that ended now; the
            # events already sent stay sent.
            self._report_end(said, words, now)
            said.end = now

    def _report_end(self, said: _Utterance, words: str, end: float) -> None:
        delays = self._world.delays
        duration = end - said.start
        if said.vad and duration >= delays.vad_min_speech:
            self._at(
                end + delays.vad_silence,
                lambda: self._vad(
                    vad.VADEvent(
                        type=vad.VADEventType.END_OF_SPEECH,
                        samples_index=0,
                        timestamp=time.time(),
                        speech_duration=duration,
                        silence_duration=delays.vad_silence,
                    )
                ),
                said,
                end,
            )
        if duration >= delays.stt_min_speech and said.final_delay is not None:
            self._at(
                end + said.final_delay,
                lambda: self._stt(_speech(stt.SpeechEventType.FINAL_TRANSCRIPT, words)),
                said,
                end,
            )
            self._at(
                end + said.final_delay + 0.01,
                lambda: self._stt(_speech(stt.SpeechEventType.END_OF_SPEECH)),
                said,
                end,
            )

    def close(self) -> None:
        for timer in self._timers:
            timer.cancel()


def _interim(text: str) -> stt.SpeechEvent:
    return _speech(stt.SpeechEventType.INTERIM_TRANSCRIPT, text)


class Microphone(io.AudioInput):
    """Silence at the pace of real time, as the room delivers it."""

    FRAME_SECONDS = 0.05
    RATE = 16_000

    def __init__(self) -> None:
        super().__init__(label="fake-microphone")
        self._next = time.monotonic()

    async def __anext__(self) -> rtc.AudioFrame:
        self._next += self.FRAME_SECONDS
        await asyncio.sleep(max(0.0, self._next - time.monotonic()))
        samples = int(self.RATE * self.FRAME_SECONDS)
        return rtc.AudioFrame(bytes(samples * 2), self.RATE, 1, samples)


# --- What the child hears and reads ----------------------------------------


class Speakers(io.AudioOutput):
    """The child's speakers. Every frame says which sentence it belongs to
    (see ``FakeVoice``), so what was heard is known exactly."""

    def __init__(self, world: World) -> None:
        # The room's output can pause, so LiveKit's false-interruption resume works.
        super().__init__(label="fake-speakers", capabilities=io.AudioOutputCapabilities(pause=True))
        self._world = world
        self._current: Played | None = None
        self._pushed = 0.0
        self._finish: asyncio.TimerHandle | None = None
        self._open = 0

    async def capture_frame(self, frame: rtc.AudioFrame) -> None:
        await super().capture_frame(frame)
        if self._current is None:
            self._current = Played(started_at=time.time())
            self._world.played.append(self._current)
            self._pushed = 0.0
            self._open += 1
            self.on_playback_started(created_at=self._current.started_at)
        marker = int(np.frombuffer(frame.data, dtype=np.int16)[0])
        text = self._world.voice_texts.get(marker)
        if text is not None and (not self._current.texts or self._current.texts[-1] != text):
            self._current.texts.append(text)
        self._pushed += frame.duration

    def flush(self) -> None:
        super().flush()
        current = self._current
        if current is None:
            return
        remaining = current.started_at + self._pushed / self._world.delays.playout_speed
        pushed = self._pushed
        loop = asyncio.get_running_loop()

        def finished() -> None:
            self._finish = None
            self._done(pushed, interrupted=False)

        self._finish = loop.call_at(loop.time() + max(0.0, remaining - time.time()), finished)
        self._current = None

    def clear_buffer(self) -> None:
        if self._finish is not None:
            self._finish.cancel()
            self._finish = None
            if self._world.played:
                self._world.played[-1].interrupted = True
            self._done(0.0, interrupted=True)
        elif self._current is not None:
            self._current.interrupted = True
            self._current = None
            self._done(0.0, interrupted=True)

    def pause(self) -> None:
        self._world.mark("paused")

    def resume(self) -> None:
        self._world.mark("resumed")

    def _done(self, position: float, *, interrupted: bool) -> None:
        if self._open <= 0:
            return
        self._open -= 1
        self.on_playback_finished(playback_position=position, interrupted=interrupted)


class Transcript(io.TextOutput):
    """What the page shows of the tutor's words."""

    def __init__(self, world: World) -> None:
        super().__init__(label="fake-transcript", next_in_chain=None)
        self._world = world

    async def capture_text(self, text: str) -> None:
        self._world.shown.append((time.time(), text))

    def flush(self) -> None:
        pass


class FakeVoiceStream(tts.SynthesizeStream):
    """Sentence by sentence, like AssemblyAI's stream: each one after the
    first-audio delay, then all its audio at once."""

    def __init__(self, voice: FakeVoice, conn_options: APIConnectOptions) -> None:
        super().__init__(tts=voice, conn_options=conn_options)
        self._voice = voice

    async def _run(self, output_emitter: tts.AudioEmitter) -> None:
        world = self._voice.world
        output_emitter.initialize(
            request_id=utils.shortuuid(),
            sample_rate=FakeVoice.RATE,
            num_channels=1,
            mime_type="audio/pcm",
            stream=True,
        )
        sentences = tokenize.blingfire.SentenceTokenizer().stream()

        async def read() -> None:
            async for data in self._input_ch:
                if isinstance(data, self._FlushSentinel):
                    sentences.flush()
                else:
                    sentences.push_text(data)
            sentences.end_input()

        reading = asyncio.create_task(read())
        started = False
        try:
            async for sentence in sentences:
                if not started:
                    output_emitter.start_segment(segment_id=utils.shortuuid())
                    started = True
                self._mark_started()
                world.voiced.append((time.time(), sentence.token))
                await asyncio.sleep(world.delays.scaled(world.delays.voice_first_audio, world.rng))
                world.made.append((time.time(), sentence.token))
                for frame in self._voice.frames_for(sentence.token):
                    output_emitter.push_frame(frame)
            if started:
                output_emitter.end_segment()
        finally:
            await utils.aio.cancel_and_wait(reading)
            await sentences.aclose()


class FakeVoice(tts.TTS):
    """The voice. Each sentence's samples carry a number that names it."""

    RATE = 24_000
    FRAME_SECONDS = 0.02
    SECONDS_PER_CHAR = 0.06

    def __init__(self, world: World) -> None:
        super().__init__(
            capabilities=tts.TTSCapabilities(streaming=True), sample_rate=self.RATE, num_channels=1
        )
        self.world = world

    def frames_for(self, text: str) -> Iterator[rtc.AudioFrame]:
        marker = self.world.marker_for(text)
        samples = int(self.RATE * self.FRAME_SECONDS)
        data = np.full(samples, marker, dtype=np.int16).tobytes()
        count = max(1, round(len(text) * self.SECONDS_PER_CHAR / self.FRAME_SECONDS))
        for _ in range(count):
            yield rtc.AudioFrame(data, self.RATE, 1, samples)

    def synthesize(
        self, text: str, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS
    ) -> tts.ChunkedStream:
        return self._synthesize_with_stream(text, conn_options=conn_options)

    def stream(
        self, *, conn_options: APIConnectOptions = DEFAULT_API_CONNECT_OPTIONS
    ) -> FakeVoiceStream:
        return FakeVoiceStream(self, conn_options)


# --- The safety gates' providers ---------------------------------------------


def _has(text: str, trigger: str) -> bool:
    return TRIGGERS[trigger] in text


class FakeModeration:
    """OpenAI's client as the moderation gate uses it."""

    def __init__(self, world: World) -> None:
        self._world = world
        self._connections = Connections(world.delays.moderation_keepalive)
        self.moderations = SimpleNamespace(create=self.create)

    async def create(self, *, model: str, input: str) -> Any:
        world = self._world
        self._world.moderated.append(input)
        warm = self._connections.take()
        delay = world.delays.scaled(world.delays.moderation, world.rng)
        if not warm:
            delay += world.delays.scaled(world.delays.new_connection, world.rng)
        if _has(input, "moderation_slow"):
            # Past the 2 s a check gets once the session's first one is done.
            delay = 2.5
        try:
            await asyncio.sleep(delay)
            if _has(input, "moderation_down"):
                raise ConnectionError("synthetic outage")
        finally:
            self._connections.give_back()
        return _moderation_answer(input)

    async def close(self) -> None:
        pass


def _moderation_answer(text: str) -> Any:
    names = [category.replace("/", "_").replace("-", "_") for category in THRESHOLDS]
    scores = dict.fromkeys(names, 0.0)
    flagged = False
    if _has(text, "violence"):
        scores["violence"], flagged = 0.9, True
    if _has(text, "self_harm"):
        scores["self_harm"], flagged = 0.9, True
    if _has(text, "minors"):
        scores["sexual_minors"], flagged = 0.9, True
    if _has(text, "faint"):
        scores["self_harm"] = 0.01
    if _has(text, "unsure_score"):
        # Over our threshold for children, and the provider itself sees nothing.
        scores["violence"] = 0.35
    categories = {name: score >= 0.5 for name, score in scores.items()}
    result = SimpleNamespace(
        flagged=flagged,
        category_scores=SimpleNamespace(**scores),
        categories=SimpleNamespace(**categories),
    )
    return SimpleNamespace(results=[result])


class FakeTypeSafe:
    """TypeSafe's two endpoints, as the physical-safety gate calls them. Its
    client keeps one connection (aiohttp, limit 1), so requests wait in turn."""

    def __init__(self, world: World) -> None:
        self._world = world
        self._connections = Connections(world.delays.typesafe_keepalive)
        self._one_at_a_time = asyncio.Lock()

    async def _wait(self) -> None:
        world = self._world
        warm = self._connections.take()
        delay = world.delays.scaled(world.delays.typesafe, world.rng)
        if not warm:
            delay += world.delays.scaled(world.delays.new_connection, world.rng)
        try:
            await asyncio.sleep(delay)
        finally:
            self._connections.give_back()

    async def send(self, body: bytes) -> bytes:
        utterance = json.loads(body)["state"]["utterance"]
        self._world.typesafe_asked.append(utterance)
        async with self._one_at_a_time:
            await self._wait()
        if _has(utterance, "typesafe_down"):
            raise ConnectionError("synthetic outage")
        risk = 0.9 if _has(utterance, "hazard") else 0.15 if _has(utterance, "unsure") else 0.01
        answer = {
            "model": TYPESAFE_MODEL,
            "answers": {"needs_adult": {"type": "noul", "noul": risk}},
        }
        return json.dumps(answer).encode()

    async def list_models(self) -> bytes:
        self._world.warmups["typesafe"] += 1
        async with self._one_at_a_time:
            await self._wait()
        return (
            b'{"models": [{"name": "jev-latest", "description": "", "release_date": "2026-09-15"}]}'
        )


# --- The tutor's model and the second reader --------------------------------


class FakeAPIError(Exception):
    """A request the real API would refuse with a 400."""


# What the API answered every request with once the account's credit ran out
# on 2026-11-25: a 400 whose message says the credit balance is too low.
NO_CREDIT = (
    "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing "
    "to upgrade or purchase credits."
)
_REFUSALS = {
    400: anthropic.BadRequestError,
    401: anthropic.AuthenticationError,
    403: anthropic.PermissionDeniedError,
    529: anthropic.OverloadedError,
}


def refusal(status: int, kind: str, message: str) -> anthropic.APIStatusError:
    """An answer of the Messages API that is not a reply, as its client raises it."""
    body = {"type": "error", "error": {"type": kind, "message": message}}
    request = httpx2.Request("POST", "https://api.anthropic.invalid/v1/messages")
    response = httpx2.Response(status, request=request, json=body)
    made = _REFUSALS.get(status, anthropic.APIStatusError)
    return made(f"Error code: {status} - {body}", response=response, body=body)


@dataclass
class _Entry:
    expires: float


class PromptCache:
    """Anthropic's prompt cache, closely enough to count reads and writes:
    a prefix match at the breakpoints, 5 minutes per entry, refreshed on a
    read, readable once the response that wrote it starts, and a 20-position
    lookback. ``tool_choice`` and ``thinking`` are part of the messages' key."""

    TTL = 300.0
    LOOKBACK = 20

    def __init__(self) -> None:
        self._entries: dict[str, _Entry] = {}

    @staticmethod
    def positions(kwargs: dict[str, Any]) -> list[tuple[str, int, bool]]:
        """(cumulative key, tokens, has a breakpoint) for each block in order."""
        out: list[tuple[str, int, bool]] = []
        digest = hashlib.sha256(str(kwargs.get("model")).encode())

        def add(block: Any, salt: str = "") -> None:
            marked = isinstance(block, dict) and "cache_control" in block
            plain = (
                {key: value for key, value in block.items() if key != "cache_control"}
                if isinstance(block, dict)
                else block
            )
            text = salt + json.dumps(plain, sort_keys=True, ensure_ascii=False)
            digest.update(text.encode())
            tokens = max(1, round(len(text) / CHARS_PER_TOKEN))
            out.append((digest.hexdigest(), tokens, marked))

        for tool in kwargs.get("tools") or []:
            add(tool)
        system = kwargs.get("system") or []
        if isinstance(system, str):
            system = [{"type": "text", "text": system}]
        for block in system:
            add(block)
        salt = json.dumps(
            {"tool_choice": kwargs.get("tool_choice"), "thinking": kwargs.get("thinking")},
            sort_keys=True,
        )
        for number, message in enumerate(kwargs.get("messages") or []):
            content = message["content"]
            blocks = [{"type": "text", "text": content}] if isinstance(content, str) else content
            for block in blocks:
                add(
                    {**block, "role": message["role"]},
                    salt=salt if number == 0 and block is blocks[0] else "",
                )
        return out

    def usage(self, kwargs: dict[str, Any]) -> tuple[int, int, int, list[str]]:
        """(read, written, uncached) tokens of a request, and the keys it writes."""
        now = time.monotonic()
        positions = self.positions(kwargs)
        marked = [index for index, (_, _, has) in enumerate(positions) if has]
        if len(marked) > 4:
            raise FakeAPIError("more than 4 cache_control breakpoints")
        total = [0]
        for _, tokens, _ in positions:
            total.append(total[-1] + tokens)
        hit = -1
        for index in marked:
            for back in range(index, max(-1, index - self.LOOKBACK - 1), -1):
                entry = self._entries.get(positions[back][0])
                if entry is not None and entry.expires > now:
                    entry.expires = now + self.TTL
                    hit = max(hit, back)
                    break
        read = total[hit + 1] if hit >= 0 else 0
        last = marked[-1] if marked else -1
        written = max(0, total[last + 1] - read) if last >= 0 else 0
        uncached = total[-1] - read - written
        return read, written, uncached, [positions[index][0] for index in marked]

    def write(self, keys: list[str]) -> None:
        expires = time.monotonic() + self.TTL
        for key in keys:
            self._entries[key] = _Entry(expires)


def _check_request(kwargs: dict[str, Any]) -> None:
    """The rules of the Messages API that a change to how the model is called
    could break, each a 400 on the real API."""
    model = str(kwargs.get("model"))
    thinking = kwargs.get("thinking")
    stream = kwargs.get("stream") is True
    if kwargs.get("max_tokens") == 0:
        if stream:
            raise FakeAPIError("max_tokens 0 with stream")
        if isinstance(thinking, dict) and thinking.get("type") == "enabled":
            raise FakeAPIError("max_tokens 0 with thinking enabled")
    if isinstance(thinking, dict):
        if thinking.get("type") == "between_tools" and (
            not model.startswith("claude-sonnet-5-5") or set(thinking) != {"type"}
        ):
            raise FakeAPIError("between_tools on another model or with other fields")
    choice = kwargs.get("tool_choice")
    if isinstance(choice, dict) and choice.get("type") in ("any", "tool"):
        raise FakeAPIError("forced tool_choice")
    messages = kwargs.get("messages") or []
    if not messages or messages[0]["role"] != "user":
        raise FakeAPIError("the first message must be the user's")
    for index, message in enumerate(messages):
        if message["role"] != "system":
            continue
        if not model.startswith("claude-sonnet-5-5"):
            raise FakeAPIError("role 'system' is not supported on this model")
        if index == 0 or messages[index - 1]["role"] != "user":
            raise FakeAPIError("a system message must follow a user message")
        if index != len(messages) - 1 and messages[index + 1]["role"] != "assistant":
            raise FakeAPIError("a system message must be last or followed by the assistant")
        content = message["content"]
        if not isinstance(content, str) and any(block.get("type") != "text" for block in content):
            raise FakeAPIError("a system message is text only")
        if not isinstance(content, str) and any("cache_control" in block for block in content):
            raise FakeAPIError("cache_control on a system message")
    for message in messages:
        content = message["content"]
        if isinstance(content, list) and any(block.get("type") == "thinking" for block in content):
            # The plugin does not replay thinking blocks; a history edit with
            # one in it is a 400 on new accounts (between_tools).
            raise FakeAPIError("a thinking block was replayed")


def _last_user(kwargs: dict[str, Any]) -> tuple[str, int]:
    """The child's last words in a request, and how many tool results came since."""
    answered = 0
    for message in reversed(kwargs.get("messages") or []):
        if message["role"] != "user":
            continue
        content = message["content"]
        blocks = [{"type": "text", "text": content}] if isinstance(content, str) else content
        if any(block.get("type") == "tool_result" for block in blocks):
            answered += 1
            continue
        texts = [block.get("text", "") for block in blocks if block.get("type") == "text"]
        return " ".join(texts), answered
    return "", answered


class _Stream:
    """What ``messages.create(stream=True)`` returns: events as they are written."""

    def __init__(self, events: AsyncIterator[Any], call: ModelCall) -> None:
        self._events = events
        self.call = call

    async def __aenter__(self) -> _Stream:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    def __aiter__(self) -> _Stream:
        return self

    async def __anext__(self) -> Any:
        event = await self._events.__anext__()
        self.call.events.append(event.type)
        return event

    async def close(self) -> None:
        self.call.closed = True
        await self._events.aclose()  # type: ignore[attr-defined]


def _chunks(text: str, size: int = 4) -> list[str]:
    return [text[i : i + size] for i in range(0, len(text), size)] or [""]


def _padded(arguments: dict[str, Any], tokens: int) -> str:
    """A tool's arguments as JSON as many tokens long as asked (the padding
    is whitespace, which JSON allows)."""
    text = json.dumps(arguments, ensure_ascii=False)
    padding = max(0, int(tokens * CHARS_PER_TOKEN) - len(text))
    return text[:-1] + " " * padding + "}"


# What the model stand-in thinks, never to be said, shown or sent back.
THOUGHT = "THOUGHT_SYNTHETIC: the plan says to check the answer first."

TOOL_ARGUMENTS = {
    "check_answer": lambda tokens: _padded({"said": "me da siete octavos"}, tokens),
    "pose_exercise": lambda tokens: _padded({"expression": "3/4 + 1/8"}, tokens),
    "show": lambda tokens: _padded(
        {"kind": "exercise", "title": "Suma", "lines": ["3/4 + 1/8 = ?"]}, tokens
    ),
}


class FakeAnthropic:
    """Anthropic's client: the tutor's model when asked to stream, the second
    reader when asked for a word."""

    def __init__(self, world: World, *, role: str, **_options: Any) -> None:
        self._world = world
        self._role = role
        self._connections = Connections(world.delays.model_keepalive)
        self._reader_connections = Connections(world.delays.reader_keepalive)
        self.messages = SimpleNamespace(create=self.create)
        self.beta = SimpleNamespace(messages=SimpleNamespace(create=self.create))
        self.models = SimpleNamespace(list=self.list_models)
        self._base_url = SimpleNamespace(netloc=b"api.anthropic.invalid")
        self.closed = False

    async def list_models(self, **_options: Any) -> Any:
        world = self._world
        world.warmups[self._role] += 1
        warm = self._reader_connections.take()
        delay = 0.05 * world.delays.scale
        if not warm:
            delay += world.delays.scaled(world.delays.new_connection, world.rng)
        await asyncio.sleep(delay)
        self._reader_connections.give_back()
        return SimpleNamespace(data=[])

    async def close(self) -> None:
        self.closed = True

    async def create(self, **kwargs: Any) -> Any:
        if str(kwargs.get("model", "")).startswith("claude-haiku"):
            return await self._read(kwargs)
        try:
            _check_request(kwargs)
            read, written, uncached, keys = self._world.cache.usage(kwargs)
        except FakeAPIError as error:
            self._world.api_errors.append(str(error))
            raise
        if self._world.model_trouble is not None:
            await self._world.model_trouble(kwargs)
        call = ModelCall(
            kwargs=kwargs,
            opened_at=time.time(),
            cache_read=read,
            cache_write=written,
            uncached=uncached,
        )
        self._world.model_calls.append(call)
        world = self._world
        warm = self._connections.take()
        cold = 0.0 if warm else world.delays.scaled(world.delays.new_connection, world.rng)
        if kwargs.get("stream") is not True:
            await asyncio.sleep(cold + world.delays.scaled(world.delays.prefill, world.rng))
            self._connections.give_back()
            world.cache.write(keys)
            call.first_token_at = call.finished_at = time.time()
            return wire.Message(
                id=f"msg_{len(world.model_calls)}",
                type="message",
                role="assistant",
                content=[],
                model=str(kwargs["model"]),
                stop_reason="max_tokens",
                stop_sequence=None,
                usage=wire.Usage(
                    input_tokens=uncached,
                    output_tokens=0,
                    cache_creation_input_tokens=written,
                    cache_read_input_tokens=read,
                ),
            )
        first = (
            cold
            + world.delays.scaled(world.delays.first_token, world.rng)
            + world.delays.scale * world.delays.per_1k_uncached * (uncached + written) / 1000
        )
        speed = world.rng.uniform(*world.delays.tokens_per_second) / world.delays.scale
        return _Stream(self._events(kwargs, call, first, speed, keys), call)

    def _step(self, kwargs: dict[str, Any]) -> list[tuple[str, str, str]]:
        """What the model writes in this step: ("text", words, "") and
        ("tool_use", name, arguments) blocks."""
        said, answered = _last_user(kwargs)
        plan = next(
            (plan for words, plan in self._world.plans.items() if words and words in said),
            None,
        )
        if plan is None:
            plan = TurnPlan(reply="Muy bien, sigamos con el siguiente.")
        tools = ((plan.tool,) if plan.tool else ()) + plan.more_tools
        if answered >= len(tools):
            return [("text", plan.reply_after_tool or plan.reply, "")]
        tool = tools[answered]
        blocks: list[tuple[str, str, str]] = []
        if plan.preamble:
            blocks.append(("text", plan.preamble, ""))
        blocks.append(("tool_use", tool, TOOL_ARGUMENTS[tool](plan.tool_tokens)))
        return blocks

    async def _events(
        self,
        kwargs: dict[str, Any],
        call: ModelCall,
        first: float,
        speed: float,
        keys: list[str],
    ) -> AsyncIterator[Any]:
        world = self._world
        try:
            await asyncio.sleep(first)
            world.cache.write(keys)
            call.first_token_at = time.time()
            yield wire.RawMessageStartEvent(
                type="message_start",
                message=wire.Message(
                    id=f"msg_{len(world.model_calls)}",
                    type="message",
                    role="assistant",
                    content=[],
                    model=str(kwargs["model"]),
                    stop_reason=None,
                    stop_sequence=None,
                    usage=wire.Usage(
                        input_tokens=call.uncached,
                        output_tokens=1,
                        cache_creation_input_tokens=call.cache_write,
                        cache_read_input_tokens=call.cache_read,
                    ),
                ),
            )
            tokens = first_block = 0
            _, answered = _last_user(kwargs)
            if world.thinking == "always" or (world.thinking == "between_tools" and answered):
                # Thinking comes first, in a block of its own that the plugin
                # must neither say nor send back.
                call.thought, first_block = True, 1
                yield wire.RawContentBlockStartEvent(
                    type="content_block_start",
                    index=0,
                    content_block=wire.ThinkingBlock(type="thinking", thinking="", signature=""),
                )
                await asyncio.sleep(1.0 / speed)
                tokens += 1
                yield wire.RawContentBlockDeltaEvent(
                    type="content_block_delta",
                    index=0,
                    delta=wire.ThinkingDelta(type="thinking_delta", thinking=THOUGHT),
                )
                yield wire.RawContentBlockDeltaEvent(
                    type="content_block_delta",
                    index=0,
                    delta=wire.SignatureDelta(type="signature_delta", signature="sig-synthetic"),
                )
                yield wire.RawContentBlockStopEvent(type="content_block_stop", index=0)
            for index, (kind, value, arguments) in enumerate(self._step(kwargs), first_block):
                if kind == "text":
                    yield wire.RawContentBlockStartEvent(
                        type="content_block_start",
                        index=index,
                        content_block=wire.TextBlock(type="text", text=""),
                    )
                    for piece in _chunks(value):
                        await asyncio.sleep(1.0 / speed)
                        tokens += 1
                        call.output_text += piece
                        yield wire.RawContentBlockDeltaEvent(
                            type="content_block_delta",
                            index=index,
                            delta=wire.TextDelta(type="text_delta", text=piece),
                        )
                else:
                    call.tool_calls.append(value)
                    call.tool_started_at = call.tool_started_at or time.time()
                    yield wire.RawContentBlockStartEvent(
                        type="content_block_start",
                        index=index,
                        content_block=wire.ToolUseBlock(
                            type="tool_use",
                            id=f"toolu_{len(world.model_calls)}_{index}",
                            name=value,
                            input={},
                        ),
                    )
                    for piece in _chunks(arguments, int(CHARS_PER_TOKEN)):
                        await asyncio.sleep(1.0 / speed)
                        tokens += 1
                        yield wire.RawContentBlockDeltaEvent(
                            type="content_block_delta",
                            index=index,
                            delta=wire.InputJSONDelta(type="input_json_delta", partial_json=piece),
                        )
                yield wire.RawContentBlockStopEvent(type="content_block_stop", index=index)
            yield wire.RawMessageDeltaEvent(
                type="message_delta",
                delta={"stop_reason": "end_turn", "stop_sequence": None},
                usage=wire.MessageDeltaUsage(output_tokens=tokens),
            )
            yield wire.RawMessageStopEvent(type="message_stop")
            call.finished_at = time.time()
        finally:
            self._connections.give_back()

    async def _read(self, kwargs: dict[str, Any]) -> Any:
        """The second reader: one word."""
        world = self._world
        text = kwargs["messages"][0]["content"]
        world.reader_calls.append((time.time(), text))
        warm = self._reader_connections.take()
        delay = world.delays.scaled(world.delays.second_reader, world.rng)
        if not warm:
            delay += world.delays.scaled(world.delays.new_connection, world.rng)
        if _has(text, "reader_slow"):
            delay = 3.0
        try:
            await asyncio.sleep(delay)
        finally:
            self._reader_connections.give_back()
        heard = "Child:" in text
        if heard:
            word = "CONCERN" if _has(text, "concern") else "ORDINARY"
        else:
            word = "SAFE"
        return SimpleNamespace(content=[SimpleNamespace(type="text", text=word)])


# --- The platform ------------------------------------------------------------

# What the platform tells the tutor about the student, sized so that a call
# carries about the 9,400 input tokens production measured.
STUDENT_CONTEXT = (
    "Lo que sabemos del estudiante: está en cuarto grado y trabaja fracciones con el mismo "
    "denominador. Le cuesta comparar fracciones con distinto denominador. "
) * 80 + "Plan de hoy: repasar fracciones equivalentes con barras y luego sumar."

ENGINE_LINES = (
    "Muy bien. Pregunta {n} de 8: ¿cuánto es tres cuartos más un octavo?",
    "Casi. Mira las barras: ¿cuántos octavos hay en tres cuartos?",
    "¡Correcto! Vamos con la siguiente.",
)


class FakePlatform:
    """The platform's agent API: the session, the reports, the engine."""

    def __init__(self, world: World) -> None:
        self._world = world
        self._reports = 0
        self._guidance = 0
        self.scripted_turns: dict[str, dict[str, Any]] = {}
        # Every so many reports the supervisor has new guidance, and once a
        # late plan. How often is not known: this cadence makes the share of
        # input read from the cache today about what production measured.
        self.guidance_every = 2
        self.late_plan_at = 3
        # Words of a child's turn after which a break is due, as the platform
        # finds after its supervisor read tiredness or a block of work ended:
        # it offers one with every report until it hears that one was taken.
        self.break_after: str | None = None
        self._break_due = False

    async def send(
        self, method: str, path: str, body: dict[str, Any] | None, timeout: float
    ) -> dict[str, Any] | None:
        world = self._world
        world.platform_calls.append((method, path, body))
        await asyncio.sleep(world.delays.scaled(world.delays.platform, world.rng))
        if path == "/v1/agent/session" and method == "GET":
            answer: dict[str, Any] = {
                "instructions": STUDENT_CONTEXT,
                "student_age": 9,
                "student_grade": "P4",
                "session_number": 3,
            }
            if world.mix == "engine":
                answer["script"] = {"lines": [{"say": "¡Hola! Empezamos.", "echoes": False}]}
            return answer
        if path == "/v1/agent/session/turns":
            assert body is not None
            world.reported_turns.extend(body["turns"])
            self._reports += 1
            answer = {}
            if self.break_after is not None and any(
                turn["role"] == "child" and self.break_after in turn["content"]
                for turn in body["turns"]
            ):
                self._break_due = True
            if self._break_due and not body.get("breaks_taken"):
                answer["pause"] = "offer"
            if self._reports == self.late_plan_at:
                answer["plan"] = "Plan tardío: practicar con barras de fracciones."
            if self.guidance_every and self._reports % self.guidance_every == 0:
                self._guidance += 1
                answer["guidance"] = [
                    {
                        "id": self._guidance,
                        "instructions": f"Guía {self._guidance}: pide que explique su idea.",
                    }
                ]
            return answer
        if path == "/v1/agent/session/said":
            assert body is not None
            for words, reply in self.scripted_turns.items():
                if words in body["said"]:
                    return reply
            return {}
        if path == "/v1/agent/session/flags":
            assert body is not None
            world.flags.append((body["gate"], body["action"], body["categories"]))
            return {}
        if path == "/v1/agent/session/end":
            world.metrics = dict((body or {}).get("metrics") or {})
            return {}
        if path in ("/v1/agent/session/exercises", "/v1/agent/session/answers"):
            return {"say": "Pídele que explique cómo lo pensó."}
        return {}


# --- Patching: no network, and the SDK clients stood in for ------------------


def _loopback(host: object) -> bool:
    return isinstance(host, str) and (
        host in ("localhost", "::1") or host.startswith("127.") or host.startswith("/")
    )


@contextlib.contextmanager
def no_network() -> Iterator[None]:
    """Refuses every connection that would leave the machine."""
    resolve, connect, connect_ex = (
        socket.getaddrinfo,
        socket.socket.connect,
        socket.socket.connect_ex,
    )

    def getaddrinfo(host: Any, *args: Any, **options: Any) -> Any:
        if not _loopback(host if not isinstance(host, bytes) else host.decode()):
            raise OSError(f"no network in the harness: {host!r}")
        return resolve(host, *args, **options)

    def guarded(original: Any) -> Any:
        def call(self: socket.socket, address: Any) -> Any:
            host = address[0] if isinstance(address, tuple) else address
            if not _loopback(host):
                raise OSError(f"no network in the harness: {host!r}")
            return original(self, address)

        return call

    socket.getaddrinfo = getaddrinfo  # type: ignore[assignment]
    socket.socket.connect = guarded(connect)  # type: ignore[method-assign]
    socket.socket.connect_ex = guarded(connect_ex)  # type: ignore[method-assign]
    try:
        yield
    finally:
        socket.getaddrinfo = resolve  # type: ignore[assignment]
        socket.socket.connect = connect  # type: ignore[method-assign]
        socket.socket.connect_ex = connect_ex  # type: ignore[method-assign]


def anthropic_client(**options: Any) -> FakeAnthropic:
    """Stands in for ``anthropic.AsyncClient(...)``: the current session's model."""
    return CURRENT_WORLD.get().model_client


def words_of(turn: int, extra: str = "") -> str:
    """What the child says in one turn: the synthetic words, a number that
    makes the turn unique, and whatever a test adds."""
    return f"{CHILD_WORDS} respuesta {turn} {extra}".strip()


def reply_for(rng: random.Random, turn: int) -> str:
    """A reply of about 35 tokens (60 at p90), one sentence 55 % of the time."""
    first = rng.choice(
        (
            "Muy bien, ahora cuéntame cómo sumaste los dos números de arriba",
            "Vas por buen camino, fíjate otra vez en los octavos que pintaste",
            "Buena idea, dime qué pasaría si partes cada cuarto en dos partes iguales",
        )
    )
    if rng.random() < 0.55:
        return f"{first}, número {turn}."
    second = rng.choice(
        (
            "Después probamos con otra suma parecida.",
            "Tómate tu tiempo y dime qué ves en la pantalla.",
        )
    )
    return f"{first}. {second} Número {turn}."


SENTENCE_END = re.compile(r"[.!?…](?:\s|$)")
