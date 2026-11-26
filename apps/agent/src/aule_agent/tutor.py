"""The tutor: what it is told to be, and where the gates and the camera plug in."""

import asyncio
import contextlib
import contextvars
import itertools
import json
import logging
import re
import time
from collections.abc import (
    AsyncGenerator,
    AsyncIterable,
    AsyncIterator,
    Awaitable,
    Callable,
    Coroutine,
)
from dataclasses import dataclass, replace
from typing import Any, Protocol

import numpy as np
from livekit import rtc
from livekit.agents import (
    Agent,
    APIConnectOptions,
    APIError,
    APIStatusError,
    FlushSentinel,
    ModelSettings,
    StopResponse,
    function_tool,
    llm,
    stt,
    tokenize,
    tts,
    utils,
)
from livekit.agents.types import USERDATA_TIMED_TRANSCRIPT
from livekit.agents.voice import SpeechHandle
from livekit.agents.voice.generation import (
    INSTRUCTIONS_MESSAGE_ID,
    mark_instructions_cache_boundary,
)

from . import answers, comparison, drill, farewell, visuals
from .greetings import greeting as written_greeting
from .homework import Reading
from .observability import new_turn
from .prompts import CHECKING, INSTRUCTIONS, PACED, SCREEN, response_language
from .providers import EARLY, REQUEST, TOOL_STARTED, WARMING, Early, Prompt
from .replies import ADULT_HELP_SEQUENCE, ANSWERABLE, MEANWHILE, REPLIES, reply
from .safety import Gates
from .script import Awaits, Engine, Line, Reply
from .timing import Timing

logger = logging.getLogger("aule.agent.tutor")

# Sends one visual to the student's screen.
Show = Callable[[dict[str, Any]], Awaitable[None]]
# Puts answers the student can tap under the question just asked (``choices``).
Offer = Callable[[dict[str, Any]], Coroutine[Any, Any, None]]


@dataclass(frozen=True)
class OpenExercise:
    """The exercise the checker has open: its id there, the expression as
    the tutor posed it, and whether the tutor is set to work on something
    else first: a worked example with other numbers, which the platform asks
    for after the last hint. What the student says meanwhile answers that,
    until the exercise is posed again."""

    id: int
    expression: str
    aside: bool = False


class Checker(Protocol):
    """Checks the student's answers without the model: the platform."""

    # The exercise open now, as the checker last said; None when none is.
    exercise: OpenExercise | None

    async def pose(self, expression: str, skill_id: str | None, form: str | None) -> str | None: ...

    async def answer(self, said: str) -> str | None: ...


class Reader(Protocol):
    """Reads what a photo of the homework shows, for the engine:
    ``homework.HomeworkReader``."""

    async def read(self, frame: rtc.VideoFrame) -> Reading: ...


# The two checking tools as the model sees them. Written out by hand: a schema
# derived from optional Python arguments declares them nullable, and the
# model's API refuses an enum on a nullable type.
POSE_EXERCISE: dict[str, Any] = {
    "name": "pose_exercise",
    "description": (
        "Register the computation you are about to ask, written as on a board: '3/4 + 1/8'; "
        "in algebra '2x + 3 = 11', '(x + 2)(x - 3)' to expand, 'x^2 - 5x + 6' to factor, "
        "'x + y = 10; x - y = 2', '3x^2 - 1 para x = 2'."
    ),
    "parameters": {
        "type": "object",
        "properties": {
            "expression": {"type": "string"},
            "skill_id": {"type": "string"},
            "form": {"type": "string", "enum": ["any", "simplified", "mixed"]},
        },
        "required": ["expression"],
    },
}
# English pronunciation practice: the sentence is registered, the student says
# it, and their voice is measured (see ``drill``), not judged by the model.
POSE_PHRASE: dict[str, Any] = {
    "name": "pose_phrase",
    "description": (
        "In English speaking practice, register the short English sentence you are about to ask "
        "the student to say back, e.g. 'Is it raining?'. Their voice is then measured to tell "
        "whether it went up or down at the end."
    ),
    "parameters": {
        "type": "object",
        "properties": {"sentence": {"type": "string"}},
        "required": ["sentence"],
    },
}
CHECK_PHRASE: dict[str, Any] = {
    "name": "check_phrase",
    "description": (
        "After the student has said the registered sentence aloud: whether their voice went up or "
        "down at the end as it should, and what to tell them."
    ),
    "parameters": {"type": "object", "properties": {}},
}
CHECK_ANSWER: dict[str, Any] = {
    "name": "check_answer",
    "description": "Check the student's answer to the registered computation.",
    "parameters": {
        "type": "object",
        "properties": {"said": {"type": "string"}},
        "required": ["said"],
    },
}

# What the model reads when an exercise or an answer could not be checked.
UNCHECKED = "Not checked: carry on by yourself."
# How a check made in code starts its call id, to tell it from the model's own.
CHECKED_IN_CODE = "aule_check_"


@dataclass(frozen=True)
class TurnCheck:
    """How the student's turn was checked, never with their words.

    ``kind`` is how code read the turn against the exercise open once it
    passed the gates (see ``answers``); None when none was open. ``told`` is
    what the checker said, None while nobody asked it. ``by`` says who asked
    it: "code" after the gates, "pose" right after the exercise the turn
    brought was posed, "model" with its own call, and "reused" for each
    later call of the model that got the same answer back.
    """

    kind: answers.Kind | None = None
    exercise: int | None = None
    told: str | None = None
    by: tuple[str, ...] = ()


@dataclass
class _Turn:
    """One turn of the student, as far as checking it goes: in memory only,
    and each turn its own, so a turn that overlaps the next one (a message
    typed while a spoken turn is checked) never writes into it."""

    # The turn before it never reached the model, or the tutor's last line was
    # a fixed one: what the student says now answers that, not the exercise.
    after_a_stop: bool = False
    # Whether it passed every input gate.
    passed: bool = False
    # Its words, once they passed every gate, when they may be checked.
    words: str = ""
    check: TurnCheck | None = None


# The student's turn that the reply running now answers, with the tutor it
# belongs to. Set as each turn begins (``Tutor._starts_a_turn``): LiveKit asks
# a spoken turn's reply in the task that awaited ``on_user_turn_completed``,
# and a typed turn's or the button's where ``generate_reply`` is called, and
# the tasks of that reply and of its tools start from a copy of that context.
# So a reply's tools read its own turn, however many turns begin after it.
_ANSWERING: contextvars.ContextVar[tuple[object, _Turn] | None] = contextvars.ContextVar(
    "aule_answering", default=None
)


# The fixed lines that are not part of the work: a gate's reply, the clock, a
# break, the pace of the session. "No sé" after one of them answers that line.
_NOT_THE_WORK = tuple(key for key in REPLIES if key not in (*MEANWHILE, "look_at_screen"))


# How long after an accepted turn a missing reply is reported. A reply normally
# starts within four seconds; the model may have begun it before the turn was
# accepted, hence the allowance.
NO_REPLY_SECONDS = 15.0
EARLY_REPLY_SECONDS = 5.0
# How long one step of the model may take, the watchdog's time: a step not
# over by then failed, as a request the model refused did.
STEP_SECONDS = NO_REPLY_SECONDS
# Failed steps in a row that end the session: the first is tried once more,
# after a fixed line, and there is no third try.
MODEL_FAILURES_TO_END = 2

# Why no request to the model can succeed for the rest of the session: its
# provider refuses the key, the account has no credit left or may not use the
# model (skill shared/error-codes.md). When the credit ran out on 2026-11-25
# the answer was a 400 that said so only in its message.
_GIVE_UP_TYPES = {
    "authentication_error": "authentication",
    "billing_error": "billing",
    "permission_error": "permission",
}
_GIVE_UP_STATUSES = {401: "authentication", 402: "billing", 403: "permission"}
_NO_CREDIT = "credit balance"

# The longest typed message that is read. A spoken turn is rarely longer.
MAX_TYPED_CHARS = 500

# What the request that warms the prompt cache asks in place of a student's
# words. The model writes nothing back (max_tokens 0).
WARM_UP = "(warm-up)"

# How long an early reply waits to be taken (see ``EarlyReply``). Later than
# this, the turn it was asked for is over.
EARLY_REPLY_KEPT_SECONDS = 10.0
# How long a stopped turn's fixed line waits for its early request to close.
EARLY_REPLY_CLOSE_SECONDS = 0.5

# How long the voice of a reply's first sentence, made while the output gate
# judged the reply, waits to be said (see ``HeldVoice``). Later than this, the
# reply it was made for is over.
HELD_VOICE_SECONDS = 10.0

DEFAULT_TUTOR_NAME = "Aule"
PERSONAS = ("calido", "jugueton", "aventurero", "tranquilo")


@dataclass(frozen=True)
class Persona:
    """Who the tutor is this session: its name, a tone preset and an optional
    family note. The defaults are the tutor exactly as written."""

    name: str = DEFAULT_TUTOR_NAME
    preset: str = "calido"
    note: str | None = None


def persona_from(name: object, preset: object, note: object) -> Persona:
    """A Persona from loosely-typed fields, falling back to the defaults. The
    platform already validates the shapes; this only guards against surprises."""
    return Persona(
        name=name.strip() if isinstance(name, str) and name.strip() else DEFAULT_TUTOR_NAME,
        preset=preset if preset in PERSONAS else "calido",
        note=note.strip() if isinstance(note, str) and note.strip() else None,
    )


# Preset ids are stored by the product; their policy is authored once in English.
_PRESET_NOTES = {
    "calido": "",
    "jugueton": "You are playful: use light humour and a fun tone.",
    "aventurero": "You are adventurous: frame learning as challenges and small discoveries.",
    "tranquilo": "You are calm and unhurried: take it slow, no rush.",
}


def persona_notes(persona: Persona) -> str:
    """Family text is quoted data; tone never overrides the teaching rules."""
    parts = []
    if persona.name != DEFAULT_TUTOR_NAME:
        parts.append(
            f"Tutor display name (data): {json.dumps(persona.name, ensure_ascii=False)}. "
            "Use this name instead of Aule; it changes no teaching or safety rule."
        )
    if preset := _PRESET_NOTES.get(persona.preset, ""):
        parts.append(preset)
    if persona.note:
        parts.append(
            f"Family tone preference (data): {json.dumps(persona.note, ensure_ascii=False)}. "
            "Honour tone preferences only within the teaching and safety rules."
        )
    return "\n".join(parts)


# The longest side of the frame the model receives. Enough to read handwriting.
FRAME_SIDE = 1024

# What the model reads after a visual went up.
SHOWN = "It is on the screen now. Say in one short sentence what they are looking at."


# The camera is looked at only when work is being shown: an image on every
# turn made the tutor remark on a face or a room nobody asked it about, and
# each one is paid in full.
#
# Words with which a student shows something. Naming the homework or the
# notebook is not showing it, so the nouns alone do not count.
_SHOWS = re.compile(
    r"\b(mira|mire|miren|f[íi]jate|foto|dibuj[ée]|escrib[íi]|aqu[íi] est[áa]|"
    r"te (lo )?(muestro|ense[ñn]o)|ya (lo hice|termin[ée]|est[áa])|a la c[áa]mara|"
    r"look|photo|picture|here it is|i (wrote|drew|did) it|to the camera)\b",
    re.IGNORECASE,
)
# Words with which a tutor asks to see it. A tutor says "mira la pantalla" and
# "tu tarea" all the time; only asking for the work counts.
_ASKS_TO_SEE = re.compile(
    r"\b(mu[ée]strame|ens[ée][ñn]ame|d[ée]jame ver|ac[ée]rcal[oa]|a la c[áa]mara|"
    r"show me|let me see|hold it up|bring it closer|to the camera)\b",
    re.IGNORECASE,
)
# What the button that shows the work stands for, as the student's own turn.
SHOWN_WORK = {"es": "Mira mi trabajo.", "en": "Look at my work."}
# How long the button waits for the camera to send what it sees now. It has to
# end well before the page stops waiting for the answer: of the time a caller
# allows, the transport keeps seven seconds for itself.
FRESH_FRAME_SECONDS = 2.0
# How long the button then waits for a line that cannot be cut before it
# answers anyway, with the answer said after that line. With the camera's wait,
# it still ends before the page stops waiting.
UNCUT_WAIT_SECONDS = 4.0
# How long what the student says waits for a photo of the homework being read
# to reach the engine, which then hears it in the state the photo left it in:
# the reader's time and then the platform's (``homework``, ``platform``).
HOMEWORK_WAIT_SECONDS = 11.0


def shows_something(chat_ctx: llm.ChatContext) -> bool:
    """Whether the student is showing their work, or was just asked to: said
    in the student's last message, or asked for in what the tutor said right
    before it."""
    messages = [item for item in chat_ctx.items if item.type == "message"]
    for item in reversed(messages):
        if item.role == "user" and _SHOWS.search(item.text_content or ""):
            return True
        if item.role == "assistant":
            # The tutor's line before the student's: nothing further back counts.
            return bool(_ASKS_TO_SEE.search(item.text_content or ""))
    return False


def with_frame(chat_ctx: llm.ChatContext, frame: rtc.VideoFrame | None) -> llm.ChatContext:
    """A copy of the context whose last user message also carries the camera frame.

    The session's own history is left alone, so a conversation keeps one image
    in play instead of one per turn.
    """
    if frame is None:
        return chat_ctx
    items = list(chat_ctx.items)
    for index in range(len(items) - 1, -1, -1):
        item = items[index]
        if item.type == "message" and item.role == "user":
            image = llm.ImageContent(
                image=frame, inference_width=FRAME_SIDE, inference_height=FRAME_SIDE
            )
            items[index] = item.model_copy(update={"content": [*item.content, image]})
            return llm.ChatContext(items)
    return chat_ctx


def with_instructions(chat_ctx: llm.ChatContext, text: str) -> llm.ChatContext:
    """A copy of the context whose instructions are ``text``, the tutor's as
    they are now.

    LiveKit copies a turn's context before ``on_user_turn_completed``, where
    the engine may change the rules for talk, so that turn's reply would be
    asked with the instructions of the turn before. Only LiveKit's own
    instructions message is touched; the session's history is left alone.
    """
    index = chat_ctx.index_by_id(INSTRUCTIONS_MESSAGE_ID)
    if index is None:
        return chat_ctx
    message = chat_ctx.items[index]
    if message.type != "message" or message.text_content == text:
        return chat_ctx
    items = list(chat_ctx.items)
    kept = [part for part in message.content if not isinstance(part, str)]
    items[index] = message.model_copy(update={"content": [text, *kept]})
    return llm.ChatContext(items)


def with_notes(instructions: str, notes: str) -> str:
    notes = notes.strip()
    return f"{instructions}\n\n{notes}" if notes else instructions


def _joined(*parts: str) -> str:
    return "\n\n".join(part.strip() for part in parts if part.strip())


def _text_of(chunk: Any) -> str:
    if isinstance(chunk, str):
        return chunk
    delta = getattr(chunk, "delta", None)
    return (delta.content or "") if delta is not None else ""


def _calls_of(chunk: Any) -> list[Any]:
    delta = getattr(chunk, "delta", None)
    return list((delta.tool_calls if delta is not None else None) or [])


# Told how long one stage of a turn took (see ``timing.STAGES``).
Took = Callable[[str, float], None]

# Where a sentence ends, for the time to the first one.
_SENTENCE_END = re.compile(r"[.!?…](?:\s|$)")


async def timed(stream: AsyncIterable[Any], took: Took) -> AsyncIterable[Any]:
    """The model's chunks as they come, telling ``took`` how long the first
    one took and the first whole sentence, or the first tool call."""
    started = time.monotonic()
    first, sentence, text = True, False, ""
    async for chunk in stream:
        now = time.monotonic()
        if first:
            took("llm_ttft", now - started)
            first = False
        if not sentence:
            text += _text_of(chunk)
            if _calls_of(chunk) or _SENTENCE_END.search(text):
                took("first_sentence", now - started)
                sentence = True
        yield chunk


# How the voice cuts what it is given into sentences: the AssemblyAI plugin's
# own default. A sentence voiced ahead is cut where the voice would cut it.
_SENTENCES = tokenize.blingfire.SentenceTokenizer()


def voiced_first(text: str, *, whole: bool) -> tuple[str, bool] | None:
    """What of ``text`` the voice may be given before the text may be said,
    and whether that is all of it.

    The voice says a sentence once the next one has begun, so the shortest
    beginning in which a second sentence has begun gets the first one said
    and nothing more. A ``whole`` text of one sentence is given whole. None
    while the first sentence is not known yet.
    """
    text = text.lstrip()
    if len(_SENTENCES.tokenize(text)) < 2:
        return (text, True) if whole and text.strip() else None
    end = len(text)
    while end > 1 and len(_SENTENCES.tokenize(text[: end - 1])) >= 2:
        end -= 1
    return text[:end], False


class ToolStart:
    """Whether the model has begun a tool call in one request. The model's
    client tells it (``providers.TOOL_STARTED``) before the call's arguments
    are written, which for a drawing takes seconds; the plugin hands the
    call over only once they are."""

    def __init__(self, took: Took) -> None:
        self.began = asyncio.Event()
        self._asked_at = time.monotonic()
        self._took = took

    def __call__(self) -> None:
        if not self.began.is_set():
            # The step is known to be a tool's (see ``timing.STAGES``).
            self._took("first_sentence", time.monotonic() - self._asked_at)
            self.began.set()


# What ``_with_tool_start`` yields once the model begins a tool call.
TOOL_CALL_BEGAN = object()


async def _with_tool_start(stream: AsyncIterable[Any], began: asyncio.Event) -> AsyncGenerator[Any]:
    """The chunks of a step as they come, and ``TOOL_CALL_BEGAN`` as soon as
    ``began`` is set: while the model writes a tool call's arguments no chunk
    comes, so the step is not otherwise known to be a tool's until it ends."""
    arrived: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()

    async def read() -> None:
        try:
            async for chunk in stream:
                arrived.put_nowait(("chunk", chunk))
        except BaseException as error:
            # Raised where the step is read, as it would have been.
            arrived.put_nowait(("failed", error))
            if not isinstance(error, Exception):
                raise
        else:
            arrived.put_nowait(("end", None))

    async def watch() -> None:
        await began.wait()
        arrived.put_nowait(("began", None))

    tasks = [asyncio.create_task(read()), asyncio.create_task(watch())]
    try:
        while True:
            kind, value = await arrived.get()
            if kind == "end":
                return
            if kind == "failed":
                raise value
            yield TOOL_CALL_BEGAN if kind == "began" else value
    finally:
        await utils.aio.cancel_and_wait(*tasks)


class NoReplyInTime(Exception):
    """A step of the model that was not over within ``STEP_SECONDS``."""


async def _in_time(stream: AsyncIterable[Any], seconds: float) -> AsyncGenerator[Any]:
    """The chunks of one step of the model as they come, while the step is
    over within ``seconds``; ``NoReplyInTime`` once it is not, with its
    request closed. A hung request is otherwise waited for through each of
    LiveKit's tries."""
    deadline = asyncio.get_running_loop().time() + seconds
    async with contextlib.aclosing(aiter(stream)) as chunks:  # type: ignore[type-var]
        while True:
            timeout = asyncio.timeout_at(deadline)
            try:
                async with timeout:
                    chunk = await anext(chunks)
            except StopAsyncIteration:
                return
            except TimeoutError:
                if timeout.expired():
                    raise NoReplyInTime() from None
                raise
            yield chunk


def _answer_behind(error: BaseException) -> BaseException:
    """The provider's own failure behind ``error``: when its retries run out,
    LiveKit raises a failure of its own, from the last one."""
    found = error
    for _ in range(4):
        cause = found.__cause__
        if not isinstance(cause, APIError):
            break
        found = cause
    return found


def why_unanswerable(error: BaseException) -> str | None:
    """Why no request to the model can succeed for the rest of the session
    ("authentication", "billing" or "permission"), or None when one may."""
    failure = _answer_behind(error)
    if not isinstance(failure, APIStatusError):
        return None
    body = failure.body if isinstance(failure.body, dict) else {}
    detail = body.get("error") if isinstance(body.get("error"), dict) else {}
    kind, message = detail.get("type"), detail.get("message")
    if isinstance(kind, str) and kind in _GIVE_UP_TYPES:
        return _GIVE_UP_TYPES[kind]
    if failure.status_code in _GIVE_UP_STATUSES:
        return _GIVE_UP_STATUSES[failure.status_code]
    if failure.status_code == 400 and isinstance(message, str) and _NO_CREDIT in message.lower():
        return "billing"
    return None


@dataclass(frozen=True)
class VoiceAhead:
    """How ``checked`` has the voice make a reply's first sentence while the
    output gate still judges the reply (``HeldVoice``)."""

    # Gives the voice this beginning of the reply; True when it is all of it.
    give: Callable[[str, bool], None]
    # The gate let this text through: what the voice made of its beginning may be said.
    approve: Callable[[str], None]
    # Nothing given to the voice so far is going to be said.
    drop: Callable[[], None]


class HeldVoice:
    """The voice of a reply's first sentence, made while the output gate still
    judges the reply (``checked``).

    The voice gets the reply's beginning, up to just past its first sentence,
    on the stream that then says the rest of the reply, and what it makes is
    held here. None of it is heard before the gate lets the reply through
    (``approved``), and then only through ``Tutor.tts_node``, for text that
    begins with those very words. Anything else drops it unheard.
    """

    def __init__(
        self, voice: tts.TTS, given: str, *, whole: bool, conn_options: APIConnectOptions
    ) -> None:
        self.given = given
        self.whole = whole
        self.approved = False
        self.given_at = time.monotonic()
        # From the text given to the voice to its first audio, once it came.
        self.first_audio: float | None = None
        self.expiry: asyncio.TimerHandle | None = None
        self._stream = voice.stream(conn_options=conn_options)
        self._stream.push_text(given)
        if whole:
            self._stream.end_input()
        self._audio: asyncio.Queue[rtc.AudioFrame | Exception | None] = asyncio.Queue()
        self._reading = asyncio.create_task(self._read())

    async def _read(self) -> None:
        try:
            async for audio in self._stream:
                if self.first_audio is None:
                    self.first_audio = time.monotonic() - self.given_at
                self._audio.put_nowait(audio.frame)
        except Exception as error:
            # Raised where the audio is played, as the voice's own failure would be.
            self._audio.put_nowait(error)
        finally:
            self._audio.put_nowait(None)

    def fits(self, text: str) -> bool:
        """Whether ``text`` begins with what the voice was given (is all of it,
        when that was whole)."""
        text = text.lstrip()
        if self.whole:
            return text.rstrip() == self.given.rstrip()
        return text.startswith(self.given)

    async def frames(self, rest: AsyncIterable[str]) -> AsyncIterable[rtc.AudioFrame]:
        """What the voice made of what it was given, then of ``rest``, said on
        the same stream: the voice cuts the whole text as it would have."""
        forwarding = asyncio.create_task(self._forward(rest))
        try:
            while (audio := await self._audio.get()) is not None:
                if isinstance(audio, Exception):
                    raise audio
                yield audio
        finally:
            await utils.aio.cancel_and_wait(forwarding)
            await self.aclose()

    async def _forward(self, rest: AsyncIterable[str]) -> None:
        if self.whole:
            return
        try:
            async for chunk in rest:
                self._stream.push_text(chunk)
        finally:
            self._stream.end_input()

    async def aclose(self) -> None:
        if self.expiry is not None:
            self.expiry.cancel()
        await self._stream.aclose()
        await utils.aio.cancel_and_wait(self._reading)


async def checked(
    stream: AsyncIterable[Any],
    gates: Gates,
    language: str,
    meanwhile: Callable[[], str] | None = None,
    *,
    took: Took | None = None,
    ahead: VoiceAhead | None = None,
    tool_began: asyncio.Event | None = None,
) -> AsyncIterable[Any]:
    """What reaches the voice from one step of the model.

    A step that calls a tool is work, not talk: every tool answers with what
    to say next, and what the model writes on its way there is its own
    reasoning ("the plan says start easy, so I show the bars before asking",
    "there is an exercise open, so I check what they said") or words said too
    soon. None of it is spoken. What ``meanwhile`` gives is said in its place:
    one short fixed line, so the student is not left in silence while the tool
    works, or nothing when the turn already had its line. It is said as soon
    as ``tool_began`` says the model has begun the call, without waiting for
    the call's arguments, and on its own, so the voice says it at once.

    Any other step is the reply, also one whose call began but never came,
    when its request was tried again and answered in words. Nothing of it
    reaches the voice before the gate on what is spoken has approved all of
    it: a safe beginning says nothing about how a sentence ends. A reply that
    does not pass is replaced by a fixed one.

    So that the reply is not then kept waiting for the voice, its first
    sentence may be given to the voice (``ahead``, AULE_VOICE_AHEAD) once the
    step is over and has called no tool, while the gate judges the whole
    reply. What the voice makes of it stays unheard until the gate has
    approved the whole reply, and is dropped when the gate says no.
    """
    chunks: list[Any] = []
    line_said = False
    # The voice, once given the reply's beginning, until it may say it.
    held: VoiceAhead | None = None
    watched = (
        _with_tool_start(stream, tool_began)
        if tool_began is not None and meanwhile is not None
        else None
    )
    try:
        async for chunk in watched if watched is not None else stream:
            if chunk is TOOL_CALL_BEGAN:
                # The model began a call: the step's line goes now, before the
                # call's arguments are written.
                if not line_said and meanwhile is not None:
                    line_said = True
                    if line := meanwhile():
                        yield line
                        yield FlushSentinel()
                continue
            chunks.append(chunk)
        if any(_calls_of(chunk) for chunk in chunks):
            left_out = sum(len(_text_of(chunk)) for chunk in chunks)
            if left_out:
                # Counts only: what was left out is never logged.
                logger.info(
                    "nothing of the model's said in a step with a tool", extra={"chars": left_out}
                )
            if not line_said:
                line = meanwhile() if meanwhile is not None else ""
                if line:
                    yield line
            for chunk in chunks:
                if not _text_of(chunk):
                    yield chunk
            return
        written = "".join(_text_of(chunk) for chunk in chunks)
        if not gates.checks_spoken:
            for chunk in chunks:
                yield chunk
            return
        if ahead is not None and (first := voiced_first(written, whole=True)):
            # The step is over and called no tool: it is the reply, and what
            # the voice needs of it goes now, while the gate judges it.
            ahead.give(*first)
            held = ahead
        # A paragraph break is not a reasoning boundary: it may separate the
        # example from its question. Provider thinking is a separate stream type,
        # and tool-step text is suppressed above. Judge the whole final reply.
        started = time.monotonic()
        decision = await gates.spoken(written)
        if took is not None:
            took("gate_out", time.monotonic() - started)
        if not decision.allowed:
            if held is not None:
                held.drop()
                held = None
            yield reply(decision.reply or "unavailable", language)
            return
        if held is not None:
            held.approve(written)
            held = None
        for chunk in chunks:
            yield chunk
    finally:
        if watched is not None:
            await watched.aclose()
        if held is not None:
            held.drop()


class HeldTimes:
    """The stage times of a request made before its turn passed the input
    gates (``EarlyReply``): kept until the tutor takes its reply, then told
    on (``tell``) with those still to come; forgotten otherwise, so a reply
    nobody heard times no stage."""

    def __init__(self) -> None:
        self._kept: list[tuple[str, float]] = []
        self._took: Took | None = None

    def __call__(self, stage: str, seconds: float) -> None:
        if self._took is not None:
            self._took(stage, seconds)
        else:
            self._kept.append((stage, seconds))

    def tell(self, took: Took) -> None:
        self._took = took
        kept, self._kept = self._kept, []
        for stage, seconds in kept:
            took(stage, seconds)


class EarlyReply:
    """The model's reply to a turn, asked while the input gates still judge
    the turn (AULE_EARLY_REPLY).

    What the model writes is kept here and nowhere else. Only the tutor's
    ``llm_node`` takes it, once the gates let the turn through, and only for
    the very request it would have made itself; otherwise it is dropped
    unseen and its stream closed. Until then nothing of it is said, shown,
    run as a tool, added to the conversation, reported or logged, and none
    of its stage times is told (``times``). The request writes nothing of the
    turn to the prompt cache and carries no camera frame (``providers.EARLY``).
    """

    def __init__(
        self,
        stream: Callable[[], AsyncIterable[Any]],
        *,
        chat_ctx: llm.ChatContext,
        tool_ids: list[str],
        tool_choice: Any,
        prompt: Prompt,
        tool_start: ToolStart,
        times: HeldTimes,
    ) -> None:
        self.chat_ctx = chat_ctx
        self.tool_ids = tool_ids
        self.tool_choice = tool_choice
        self.prompt = prompt
        self.tool_start = tool_start
        self.times = times
        # The request, and whether the tutor took its reply (``usage``).
        self.request = Early()
        self.asked_at = time.monotonic()
        self._chunks: list[Any] = []
        self._error: Exception | None = None
        self._done = False
        self._more = asyncio.Event()
        self._task = asyncio.create_task(self._read(stream))

    async def _read(self, stream: Callable[[], AsyncIterable[Any]]) -> None:
        # Read by the model's client as the request is laid out and its
        # events come in, and by ``usage`` when its call is counted (``providers``).
        REQUEST.set(self.prompt)
        TOOL_STARTED.set(self.tool_start)
        EARLY.set(self.request)
        try:
            async with contextlib.aclosing(stream()) as chunks:  # type: ignore[type-var]
                async for chunk in chunks:
                    self._chunks.append(chunk)
                    self._more.set()
        except Exception as error:
            # Raised where the reply is taken, as a failed request would be.
            self._error = error
        finally:
            self._done = True
            self._more.set()

    def matches(
        self,
        chat_ctx: llm.ChatContext,
        tools: list[llm.Tool],
        model_settings: ModelSettings | None,
        prompt: Prompt,
        frame: rtc.VideoFrame | None,
    ) -> bool:
        """Whether this is the request the tutor is about to make: the same
        conversation, tools, tool choice and prompt, no camera frame, in time.
        The same test LiveKit makes before it uses a preemptive generation."""
        tool_choice = model_settings.tool_choice if model_settings is not None else None
        return (
            time.monotonic() - self.asked_at <= EARLY_REPLY_KEPT_SECONDS
            and chat_ctx.is_equivalent(self.chat_ctx)
            and [tool.id for tool in tools] == self.tool_ids
            and tool_choice == self.tool_choice
            and prompt == self.prompt
            and frame is None
        )

    async def chunks(self) -> AsyncIterable[Any]:
        """What the model wrote so far, then the rest as it comes."""
        taken = 0
        while True:
            while taken < len(self._chunks):
                yield self._chunks[taken]
                taken += 1
            if self._done:
                if self._error is not None:
                    raise self._error
                return
            self._more.clear()
            await self._more.wait()

    def drop(self) -> None:
        """Stops the request, if it still runs, and forgets what it wrote."""
        self._task.cancel()
        self._chunks.clear()

    async def closed(self, timeout: float) -> None:
        """Once the request has stopped, or after ``timeout``."""
        await asyncio.wait({self._task}, timeout=timeout)


async def _then(first: str, rest: AsyncIterator[str]) -> AsyncIterable[str]:
    """``first``, then what is left of ``rest``."""
    if first:
        yield first
    async for chunk in rest:
        yield chunk


async def _replayed(frames: list[rtc.AudioFrame]) -> AsyncIterable[rtc.AudioFrame]:
    """New frames with the audio of ``frames``, and the timing of its words."""
    for frame in frames:
        userdata: dict[str, Any] = {}
        if (words := frame.userdata.get(USERDATA_TIMED_TRANSCRIPT)) is not None:
            userdata[USERDATA_TIMED_TRANSCRIPT] = list(words)
        yield rtc.AudioFrame(
            bytes(frame.data),
            frame.sample_rate,
            frame.num_channels,
            frame.samples_per_channel,
            userdata=userdata,
        )


def _check_pair(said: str, told: str) -> list[llm.ChatItem]:
    """A check made in code, as the model would have made it: its
    check_answer call and the checker's answer to it."""
    call = llm.FunctionCall(
        call_id=utils.shortuuid(CHECKED_IN_CODE),
        name="check_answer",
        arguments=json.dumps({"said": said}, ensure_ascii=False),
    )
    output = llm.FunctionCallOutput(
        call_id=call.call_id, name="check_answer", output=told, is_error=False
    )
    return [call, output]


async def present(visual: object, gates: Gates, show: Show) -> str:
    """Puts a visual on the student's screen, if it can be drawn and may be read.

    Returns what the model is told next. The model tends to call the tool
    without saying anything, so a shown visual asks it for the sentence that
    goes with it; one that was not shown says why, so the model can correct it.
    """
    found = visuals.problems(visual)
    if found:
        return f"Not shown: {found[0]}"
    assert isinstance(visual, dict)
    # What is read on the screen passes the same gate as what is spoken.
    if not (await gates.spoken(visuals.text_of(visual))).allowed:
        return "Not shown: that text cannot be put on the screen."
    await show(visual)
    return SHOWN


class Tutor(Agent):
    def __init__(
        self,
        *,
        language: str,
        gates: Gates,
        camera: Any = None,
        context: str = "",
        show: Show | None = None,
        persona: Persona | None = None,
        checker: Checker | None = None,
        student_name: str | None = None,
        session_number: int | None = None,
        engine: Engine | None = None,
        reader: Reader | None = None,
        breaks: bool = False,
        timing: Timing | None = None,
        early_reply: bool = False,
        voice: tts.TTS | None = None,
        voice_ahead: bool = False,
        offer: Offer | None = None,
    ) -> None:
        # `context` is what the platform knows about this student and the
        # supervisor's plan for the session; empty when there is no platform.
        # `show` is given when the student has a screen to draw on, and
        # `offer` when it can put answers to tap under a question (``choices``).
        # `voice` is the session's voice: the short lines said while a tool
        # works are voiced with it once, and with `voice_ahead` the first
        # sentence of a reply while the output gate judges it (``HeldVoice``).
        # `checker` judges answers to computations, so the model neither has to
        # work them out nor holds the answer of an exercise that is still open.
        # `student_name` and `session_number` only choose and fill the greeting.
        # `engine` is the session engine: what it wrote is said as written, and
        # the model speaks only when the student leaves the script. `reader`
        # reads a photo of the homework for it when it waits for one.
        # `persona` is the tutor's name, tone preset and (already-moderated)
        # family note; the default leaves the prompt exactly as written.
        persona = persona or Persona()
        instructions = INSTRUCTIONS
        # The checker hears one thing at a time. LiveKit runs the calls of one
        # step side by side, so without it an answer checked in the same step
        # as its exercise is posed could reach the platform first, and be
        # judged against the exercise before, or against none.
        self._checking = asyncio.Lock()
        self._checker = checker
        # The student's turn now. Before the first nothing was stopped.
        self._turn = _Turn(passed=True)
        # The open exercise the tutor stepped off with a pose the checker did not
        # take (not arithmetic it can check, or a call that failed): the tutor
        # asks something else, and the exercise stays open behind it.
        self._posed_elsewhere: int | None = None
        self._fixed_lines = frozenset(reply(key, language) for key in _NOT_THE_WORK)

        @function_tool(raw_schema=comparison.SCHEMA)
        async def compare_numbers(raw_arguments: dict[str, object]) -> str:
            return comparison.compare(raw_arguments.get("left"), raw_arguments.get("right"))

        tools = [compare_numbers]
        if show is not None:
            instructions = with_notes(instructions, SCREEN)

            @function_tool(raw_schema=visuals.tool_schema())
            async def show_tool(raw_arguments: dict[str, object]) -> str:
                told = await present(raw_arguments, gates, show)
                self._drew = self._drew or told == SHOWN
                return told

            tools.append(show_tool)
        if breaks:
            instructions = with_notes(instructions, PACED)
        if checker is not None:
            instructions = with_notes(instructions, CHECKING)

            @function_tool(raw_schema=POSE_EXERCISE)
            async def pose_exercise(raw_arguments: dict[str, object]) -> str:
                expression, skill_id, form = (
                    raw_arguments.get(key) for key in ("expression", "skill_id", "form")
                )
                if not isinstance(expression, str) or not expression.strip():
                    return UNCHECKED
                async with self._checking:
                    before = checker.exercise
                    told = await checker.pose(
                        expression,
                        skill_id if isinstance(skill_id, str) else None,
                        form if isinstance(form, str) else None,
                    )
                    # Not taken, the tutor asks something else now, and the
                    # exercise before stays open behind it until it is posed again.
                    self._posed_elsewhere = (
                        before.id if told is None and before is not None else None
                    )
                    return await self._checked_after_a_pose(checker, before, told or UNCHECKED)

            @function_tool(raw_schema=CHECK_ANSWER)
            async def check_answer(raw_arguments: dict[str, object]) -> str:
                said = raw_arguments.get("said")
                if not isinstance(said, str) or not said.strip():
                    return UNCHECKED
                return await self._checked_by_the_model(checker, said)

            tools += [pose_exercise, check_answer]

        practice = drill.Drill()

        @function_tool(raw_schema=POSE_PHRASE)
        async def pose_phrase(raw_arguments: dict[str, object]) -> str:
            sentence = raw_arguments.get("sentence")
            return practice.pose(sentence if isinstance(sentence, str) else "")

        @function_tool(raw_schema=CHECK_PHRASE)
        async def check_phrase(raw_arguments: dict[str, object]) -> str:
            expected = practice.expected
            said, contour = practice.check()
            # The student sees the tune of their own voice, drawn from the measurement.
            if contour is not None and expected is not None and show is not None:
                await show(drill.visual(contour, expected, language))
            return said

        tools += [pose_phrase, check_phrase]
        # Tone is subordinate by explicit policy, not by its position in the prompt.
        self._rules = instructions
        self._context = context
        self._tone = persona_notes(persona)
        self._guidance = ""
        self._drill = practice
        self._language = language
        self._rules_for_talk = ""
        self._base = self._prompt().system
        super().__init__(instructions=self._instructions_now(), tools=tools)
        self._gates = gates
        self._camera = camera
        # The short lines said while a tool works, one after the other, and
        # whether this turn of the student still has one coming: a second tool
        # in the same turn works in silence, or the lines would pile up.
        self._meanwhiles = itertools.cycle(MEANWHILE)
        self._meanwhile_due = True
        # The same for the line said when the model fails, once a turn; the
        # steps that failed in a row, and whether the model was given up on
        # for the session, which then closes (``on_unavailable``).
        self._hold_on_due = True
        self._failures = 0
        self._given_up = False
        # Whether this turn of the student put something on the screen.
        self._drew = False
        # The frame taken when the student pressed the button, until it is used.
        self._shown: rtc.VideoFrame | None = None
        self._hazards_in_a_row = 0
        # Told how sure the speech recognition was of each final transcript,
        # and how long each stage of a push-to-talk turn took.
        self._timing = timing
        # Whether the hearing heard speech after its last final transcript.
        self._words_in_flight = False
        # Whether a turn's reply is asked while the gates judge it, the reply
        # asked so, and how many were taken and dropped (counts only).
        self._asks_early = early_reply
        self._early: EarlyReply | None = None
        self.early_replies = {"used": 0, "dropped": 0}
        # What the voice made ahead of it being said: the lines said while a
        # tool works, made once, and with `voice_ahead` the first sentence of
        # the reply the output gate is judging.
        self._voice = voice
        self._lines_voiced: dict[str, list[rtc.AudioFrame]] = {}
        self._held: HeldVoice | None = None
        # How often each was said, and how often a sentence was not (counts only).
        self.voiced_ahead = {"sentences_said": 0, "sentences_dropped": 0, "lines_said": 0}
        self._ahead = (
            VoiceAhead(give=self._give_voice, approve=self._approve_voice, drop=self._drop_voice)
            if voice is not None and voice_ahead
            else None
        )
        self._engine = engine
        # Which answer of the engine is being said. Lines of an older one stop
        # as soon as a newer answer arrives.
        self._script_turn = 0
        # What the engine waits for, as its last answer said; and, while a
        # photo of the homework is read, what is set once the engine has
        # heard what it showed.
        self._awaits: Awaits | None = None
        self._reader = reader
        self._reading: asyncio.Event | None = None
        self._show = show
        # Where answers to tap go (``choices``).
        self._offer = offer
        self._model_done_at = 0.0
        self._watches: set[asyncio.Task[None]] = set()
        self._tutor_name = persona.name
        self._student_name = student_name
        self._session_number = session_number
        # What closes the session when the student says goodbye, and when the
        # model cannot answer any more; set by the worker, which owns the
        # session's pace and its platform.
        self.on_goodbye: Callable[[], None] | None = None
        self.on_unavailable: Callable[[], None] | None = None

    def _goodbye(self, text: str) -> bool:
        """Whether this turn was the student's goodbye, and the session now closes."""
        if self.on_goodbye is None or not farewell.said_goodbye(text):
            return False
        self.on_goodbye()
        return True

    @property
    def turn_check(self) -> TurnCheck | None:
        """How the student's turn now was checked; None while it was not."""
        return self._turn.check

    def _starts_a_turn(self, *, passed: bool = False) -> _Turn:
        """A new turn of the student. Nothing of the turn before is checked with
        it; whether that turn was stopped is kept with it."""
        self._turn = _Turn(after_a_stop=not self._turn.passed, passed=passed)
        _ANSWERING.set((self, self._turn))
        return self._turn

    def _turn_answered(self) -> _Turn:
        """The student's turn that the reply running now answers: the one it
        was asked for, though newer turns may have begun since. A reply asked
        for no turn of this tutor's answers none: it reuses no check, and
        checks none of the student's words."""
        answering = _ANSWERING.get()
        if answering is not None and answering[0] is self:
            return answering[1]
        return _Turn(passed=True)

    def _after_a_fixed_line(self) -> bool:
        """Whether the tutor's last line was a fixed one that is not part of the
        work: a gate's reply, the output gate's in place of a reply included."""
        for item in reversed(self.chat_ctx.items):
            if item.type == "message" and item.role == "assistant":
                return (item.text_content or "").strip() in self._fixed_lines
        return False

    async def _check_after_the_gates(self, turn: _Turn, words: str) -> list[llm.ChatItem]:
        """Checks the student's answer, or their "no sé", to the exercise open,
        in code: after the turn passed every input gate, before the model is
        asked, so that no answer goes unchecked because the model forgot.

        The model reads the check in the conversation as if it had made it:
        a check_answer call and its output, saved in the history and returned
        for this turn's request. Nothing is checked when no exercise is open,
        and only what ``answers`` sends; the model checks the rest itself. A
        turn after one the gates stopped, or after a fixed line, answers that
        line and is left to the model whole, and so is a turn that answers
        something else the tutor asked while the exercise stays open
        (``_asked_something_else``). Never raises: a check that cannot be made
        leaves the turn as before.
        """
        turn.passed = True
        if self._checker is None:
            return []
        answers_a_line = turn.after_a_stop or self._after_a_fixed_line()
        if not answers_a_line:
            turn.words = words
        try:
            async with self._checking:
                exercise = self._checker.exercise
                if exercise is None:
                    return []
                reading = (
                    answers.Reading(None, "left", False)
                    if answers_a_line or self._asked_something_else(exercise)
                    else answers.to_check(words, exercise.expression, self._language)
                )
                check = TurnCheck(kind=reading.kind, exercise=exercise.id)
                turn.check = check
                if reading.said is None:
                    return []
                started = time.monotonic()
                told = await self._told(self._checker, reading.said)
                turn.check = replace(check, told=told, by=("code",))
            # Kinds and time only: never the words, nor what the checker said.
            logger.info(
                "answer checked after the gates",
                extra={
                    "kind": reading.kind,
                    "restated": reading.restated,
                    "checked": told != UNCHECKED,
                    "seconds": round(time.monotonic() - started, 2),
                },
            )
            # Saved even when a newer turn has begun since: the checker heard it.
            checked = _check_pair(reading.said, told)
            context = self.chat_ctx.copy()
            context.insert(checked)
            await self.update_chat_ctx(context)
            return checked
        except asyncio.CancelledError:
            raise
        except Exception as error:
            logger.warning(
                "answer not checked after the gates", extra={"error": type(error).__name__}
            )
            return []

    def _asked_something_else(self, exercise: OpenExercise) -> bool:
        """Whether what the tutor asked last is not ``exercise``, though it
        stays open: a worked example with other numbers comes first, as the
        platform asked, or a pose of something else was not taken, both until
        the exercise is posed again; or what the tutor said and showed since
        the student's last message names numbers other than the exercise's
        own and its steps' (``answers.names_other_numbers``). The student's
        reply answers that, and is left to the model, whose own check still
        works."""
        return (
            exercise.aside
            or exercise.id == self._posed_elsewhere
            or answers.names_other_numbers(
                self._said_since_the_student(), exercise.expression, self._language
            )
        )

    def _said_since_the_student(self) -> str:
        """What the tutor said since the student's last message, and the text
        of what it put on the screen meanwhile, which it does not read aloud."""
        said: list[str] = []
        for item in reversed(self.chat_ctx.items):
            if item.type == "message" and item.role == "user":
                break
            if item.type == "message" and item.role == "assistant":
                said.append(item.text_content or "")
            elif item.type == "function_call" and item.name == "show":
                with contextlib.suppress(ValueError):
                    visual = json.loads(item.arguments)
                    if isinstance(visual, dict):
                        said.append(visuals.text_of(visual))
        return " ".join(reversed(said))

    async def _checked_by_the_model(self, checker: Checker, said: str) -> str:
        """The model's own check_answer: one call to the checker per turn and
        exercise. The turn is the one this reply answers, even when a newer
        one has begun: already checked against the exercise open now, or
        against the one its check closed, it gets the same answer back."""
        async with self._checking:
            exercise = checker.exercise
            open_now = exercise.id if exercise is not None else None
            turn = self._turn_answered()
            done = turn.check
            if done is not None and done.told is not None and open_now in (done.exercise, None):
                turn.check = replace(done, by=(*done.by, "reused"))
                return done.told
            told = await self._told(checker, said)
            kind = done.kind if done is not None else None
            turn.check = TurnCheck(kind=kind, exercise=open_now, told=told, by=("model",))
            return told

    async def _checked_after_a_pose(
        self, checker: Checker, before: OpenExercise | None, told: str
    ) -> str:
        """What the model reads after posing an exercise. When the student's
        turn this reply answers brought that exercise with their answer
        ("Estoy haciendo 25 + 3 × 2. Me salió 56"), nothing was open to check
        it against after the gates: it is checked now, against the exercise
        just opened. Only when their words say it again as posed, or an answer
        to the exercise before, or "tengo 10 años", would be taken for an
        answer to it. Called with the checker's lock held."""
        posed, turn = checker.exercise, self._turn_answered()
        if (
            posed is None
            or (before is not None and posed.id == before.id)
            or (turn.check is not None and turn.check.told is not None)
        ):
            return told
        reading = answers.to_check(turn.words, posed.expression, self._language)
        if not reading.restated or reading.said is None:
            return told
        answer = await self._told(checker, reading.said)
        turn.check = TurnCheck(kind=reading.kind, exercise=posed.id, told=answer, by=("pose",))
        # The kind only: never the words, nor what the checker said.
        logger.info("answer checked after a pose", extra={"kind": reading.kind})
        return f"{told} Their answer in this turn, checked: {answer}"

    async def _told(self, checker: Checker, said: str) -> str:
        """What the checker says of ``said``; UNCHECKED when it could not tell.
        Not tried again: a call that timed out may still have been counted."""
        try:
            return await checker.answer(said) or UNCHECKED
        except asyncio.CancelledError:
            raise
        except Exception as error:
            # The type only: an error may quote what was sent.
            logger.warning("answer not checked", extra={"error": type(error).__name__})
            return UNCHECKED

    async def advise(self, guidance: str) -> None:
        """Applies the supervisor's latest guidance to the turns that follow.

        It replaces the previous guidance instead of piling up. It is one of
        the notes (see ``_prompt``): sent after the prefix the prompt cache
        reads, which it leaves as it was.
        """
        self._guidance = guidance
        await self.update_instructions(self._instructions_now())

    async def plan(self, plan: str) -> None:
        """Takes the supervisor's plan when it arrives after the session began.

        The greeting does not wait for it. It joins what is known about the
        student, before the tone lines, exactly where it would have been had
        it come with the first call.
        """
        self._context = with_notes(self._context, plan)
        self._base = self._prompt().system
        await self.update_instructions(self._instructions_now())

    async def warm_the_model(self) -> None:
        """Writes the prompt cache of the tools and the instructions while the
        greeting is said, so the first reply reads them instead of waiting for
        them to be written. One request that returns nothing, with no student's
        words, laid out as a reply is: the same prefix, then the notes with the
        output-language rule last. A failure only means the first reply writes
        them itself."""
        prompt = self._prompt()
        chat = llm.ChatContext(
            [
                llm.ChatMessage(role="system", content=[prompt.text]),
                llm.ChatMessage(role="user", content=[WARM_UP]),
            ]
        )
        warming = WARMING.set(True)
        request = REQUEST.set(prompt)
        try:
            async for _ in Agent.default.llm_node(self, chat, self.tools, ModelSettings()):
                pass
        except Exception as error:
            logger.info("model not warmed", extra={"error": type(error).__name__})
        finally:
            REQUEST.reset(request)
            WARMING.reset(warming)

    def _prompt(self) -> Prompt:
        """What the model is told now (``PROMPTS.md``): the rules, the
        student's part (what is known of them, the plan, then the tone) and
        the notes of this moment, which end with the output-language rule:
        the last instruction of every request, after any update."""
        return Prompt(
            rules=self._rules,
            student=_joined(self._context, self._tone),
            notes=_joined(self._guidance, self._rules_for_talk, response_language(self._language)),
        )

    async def on_enter(self) -> None:
        # The engine's own opening when it runs the session; otherwise a
        # written greeting. Either way no model writes the first words.
        opening = self._engine.opening() if self._engine is not None else Reply()
        self._awaits = opening.awaits
        if opening.lines:
            await self._say(opening.lines)
            self._voice_the_lines_ahead()
            return
        # A written greeting, said at once. The name is a family's own text, so
        # the greeting with it is judged like anything else that is spoken, and
        # the one without it is said if that does not pass.
        named = written_greeting(
            self._language, self._tutor_name, self._student_name, self._session_number
        )
        allowed = self._student_name is None or (await self._gates.spoken(named)).allowed
        text = (
            named
            if allowed
            else written_greeting(self._language, self._tutor_name, None, self._session_number)
        )
        await self.session.say(text, add_to_chat_ctx=True, allow_interruptions=True)
        self._voice_the_lines_ahead()

    def _voice_the_lines_ahead(self) -> None:
        """Has the voice make the lines said while a tool works, once, out of
        the opening's way, so that a tool step's line plays without waiting
        for the voice. Not waited for: a line not made in time is voiced when
        it is said, as before."""
        if self._voice is not None:
            self._in_background(self._voice_the_lines(self._voice))

    async def _voice_the_lines(self, voice: tts.TTS) -> None:
        for key in MEANWHILE:
            text = reply(key, self._language)
            try:
                async with voice.synthesize(text) as stream:
                    frames = [audio.frame async for audio in stream]
            except Exception as error:
                logger.info("line not voiced ahead", extra={"error": type(error).__name__})
                continue
            if frames:
                self._lines_voiced[text] = frames

    def _in_background(self, work: Coroutine[Any, Any, None]) -> None:
        task = asyncio.create_task(work)
        self._watches.add(task)
        task.add_done_callback(self._watches.discard)

    async def _put_up(self, offered: dict[str, Any]) -> None:
        """Sends answers to tap to the screen. A failure costs only the buttons:
        the student can still say or type the answer."""
        if self._offer is None:
            return
        try:
            await self._offer(offered)
        except Exception as error:
            # The type only, and no options: counts and kinds are what is logged.
            logger.info("choices not sent", extra={"error": type(error).__name__})

    async def _say(self, lines: tuple[Line, ...]) -> None:
        """Says lines of the script as they are written, each with its drawing.

        No model writes them and none judges them: they are the engine's own,
        read by people before a student hears them. They join the conversation
        so that what the student says next has something to refer to.
        """
        self._script_turn += 1
        turn = self._script_turn
        lines = await self._judged(lines)
        said = 0
        for line in lines:
            if turn != self._script_turn:
                # A newer answer of the engine came in, for an answer written on
                # the page: what is left of this one belongs to an exercise
                # that is over, drawing included.
                break
            if line.show is not None and self._show is not None:
                await self._show(line.show)
            # One after the other: a drawing goes up with the line it belongs to.
            played = await self.session.say(
                line.say, add_to_chat_ctx=True, allow_interruptions=True
            )
            said += 1
            if line.choices is not None and turn == self._script_turn and not played.interrupted:
                # What can be tapped goes under its question once it has been heard.
                await self._put_up(line.choices)
        # Counts only: what is said is never logged.
        logger.info("said from the script", extra={"lines": said, "left_out": len(lines) - said})

    async def _judged(self, lines: tuple[Line, ...]) -> tuple[Line, ...]:
        """The lines that may be said. Those that may repeat the student's
        words are judged together, once, before any of them is spoken; if they
        do not pass, the fixed redirect takes their place and the engine's own
        lines are still said."""
        echoing = [line.say for line in lines if line.echoes]
        if not echoing or not self._gates.checks_spoken:
            return lines
        if (await self._gates.spoken(" ".join(echoing))).allowed:
            return lines
        own = tuple(line for line in lines if not line.echoes)
        return (Line(say=reply("redirect", self._language), echoes=False), *own)

    async def scripted_lines(self, said: Reply) -> None:
        """Lines the engine wrote for something that did not come through the
        tutor: an answer typed on the page. Whatever was being said stops, as
        when the student types to the tutor itself, and so do the lines of the
        engine's previous answer that were still to come."""
        self._script_turn += 1
        self._awaits = said.awaits
        await self.session.interrupt()
        if said.lines:
            await self._say(said.lines)
        if said.closed:
            self.session.shutdown()

    async def _scripted(self, text: str) -> bool:
        """Lets the engine answer what the student said. True when the turn is
        over and the model must not be called."""
        if self._engine is None:
            return False
        await self._after_the_photo()
        reply = await self._engine.said(text)
        # Like the rules for talk, what the engine waits for is what its
        # answer says; no answer, and the turn is the model's, as without it.
        self._awaits = reply.awaits if reply is not None else None
        rules = reply.converse if reply is not None else None
        if (rules or "") != self._rules_for_talk:
            # What the model may do while the student talks changes with the
            # moment of the session (no hints in a measurement, for one). The
            # reply to this very turn follows them too (``llm_node``).
            self._rules_for_talk = rules or ""
            await self.update_instructions(self._instructions_now())
        if reply is None:
            return False
        if reply.lines:
            await self._say(reply.lines)
        if reply.closed:
            # The engine's last lines were its goodbye; the session closes
            # once they have been heard.
            self.session.shutdown()
            return True
        return reply.converse is None

    def _instructions_now(self) -> str:
        return self._prompt().text

    async def on_user_turn_completed(
        self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage
    ) -> None:
        # The turn's model calls, from the second reader of its words to the
        # last step of its reply, share one random id (``observability``),
        # and so do the stages of the turn, if it is staged.
        trace = new_turn()
        if self._timing is not None:
            self._timing.traced(trace)
        self._meanwhile_due = self._hold_on_due = True
        self._drew = False
        turn = self._starts_a_turn()
        # A spoken turn during a drill is the student's try (a typed one never comes here).
        self._drill.took()
        self._drop_voice()
        self._ask_early(turn_ctx, new_message)
        try:
            if not await self._may_answer(turn_ctx, new_message):
                # The stopped turn gets no reply: StopResponse discards it. An
                # early reply asked for it is dropped unseen.
                raise StopResponse()
            if self._given_up:
                # The model cannot answer any more and the session is closing.
                raise StopResponse()
            if self._goodbye(new_message.text_content or ""):
                raise StopResponse()
            if await self._scripted(new_message.text_content or ""):
                # The engine answered. The student's words stay in the
                # conversation; the model is not asked.
                turn_ctx.items.append(new_message)
                await self.update_chat_ctx(turn_ctx)
                raise StopResponse()
            checked = await self._check_after_the_gates(turn, new_message.text_content or "")
            if checked:
                # A reply asked before the check cannot hold it: it is dropped
                # unseen, and the reply is asked again with the check in it.
                self._drop_early_reply()
                turn_ctx.insert(checked)
        except BaseException:
            self._drop_early_reply()
            raise
        watch = asyncio.create_task(self._report_a_missing_reply(time.monotonic()))
        self._watches.add(watch)
        watch.add_done_callback(self._watches.discard)

    async def _report_a_missing_reply(self, accepted_at: float) -> None:
        """Says in the log when an accepted turn got nothing back.

        A session that goes quiet leaves no error behind; this is the trace of
        where it stopped: before the model answered, or between it and the voice.
        """
        await asyncio.sleep(NO_REPLY_SECONDS)
        answered = self._model_done_at >= accepted_at - EARLY_REPLY_SECONDS
        try:
            state = self.session.agent_state
        except RuntimeError:
            # The session ended while waiting: there is nobody left to answer.
            return
        if not answered or state == "thinking":
            logger.warning(
                "no reply after an accepted turn",
                extra={"seconds": NO_REPLY_SECONDS, "model_answered": answered, "state": state},
            )

    async def typed(self, text: str) -> SpeechHandle | None:
        """A message typed instead of spoken.

        It is judged like a spoken turn before the model sees it. Without this
        a typed message would go straight to the model, past both input gates.
        Returns the reply asked for it, or None when the model is not asked.
        """
        text = text.strip()[:MAX_TYPED_CHARS]
        if not text:
            return None
        new_turn()
        self._meanwhile_due = self._hold_on_due = True
        self._drew = False
        turn = self._starts_a_turn()
        await self._interrupt()
        message = llm.ChatMessage(role="user", content=[text])
        if not await self._may_answer(self.chat_ctx.copy(), message):
            return None
        if self._goodbye(text):
            return None
        if await self._scripted(text):
            context = self.chat_ctx.copy()
            context.items.append(message)
            await self.update_chat_ctx(context)
            return None
        await self._check_after_the_gates(turn, text)
        # The message the gates judged, under an id of its own: as with a reply
        # asked with the text, the gates' history keeps theirs and the
        # conversation another. Made before the gates, it goes before the check.
        written = message.model_copy(deep=True, update={"id": utils.shortuuid("item_")})
        return self.session.generate_reply(user_input=written)

    def _meanwhile(self) -> str:
        if not self._meanwhile_due:
            return ""
        self._meanwhile_due = False
        return reply(next(self._meanwhiles), self._language)

    def _hold_on(self) -> str:
        if not self._hold_on_due:
            return ""
        self._hold_on_due = False
        return reply("hold_on", self._language)

    def _failed(self, error: Exception) -> bool:
        """Counts a step of the model that failed or was not over in time.
        True when it is tried once more; False when the model is given up on
        for the rest of the session, which then closes (``on_unavailable``)."""
        self._failures += 1
        failure = _answer_behind(error)
        cause = why_unanswerable(failure)
        # Its type and status only: a provider's message may quote the request.
        facts = {
            "error": type(failure).__name__,
            "status": failure.status_code if isinstance(failure, APIStatusError) else None,
            "failures": self._failures,
        }
        if cause is None and self._failures < MODEL_FAILURES_TO_END:
            logger.info("model step failed, trying it once more", extra=facts)
            return True
        self._given_up = True
        logger.warning("tutor model unavailable", extra={**facts, "cause": cause or "in_a_row"})
        if self.on_unavailable is not None:
            self.on_unavailable()
        return False

    async def show_work(self) -> bool:
        """The student pressed the button that shows their work: the tutor
        looks at what the camera sees now and answers at once. False when the
        camera sent nothing to look at, and then nothing is said.

        While the engine waits for a photo of the homework, the photo goes to
        the reader and never to the tutor's model, and the button is answered
        as soon as the reading has begun (``_look_at_the_homework``). A press
        while one is read is answered and changes nothing."""
        if self._camera is None:
            return False
        if self._reading is not None and not self._reading.is_set():
            return True
        frame = await self._camera.fresh(FRESH_FRAME_SECONDS)
        if frame is None:
            return False
        homework = self._homework_wanted()
        if homework is None:
            self._shown = frame
        new_turn()
        self._meanwhile_due = self._hold_on_due = True
        self._drew = False
        # A turn of its own, with no words to check: a button is never stopped.
        self._starts_a_turn(passed=True)
        # The page is waiting for this answer: a long line that cannot be cut is
        # not waited for to its end, and the reply is said after it instead.
        await self._interrupt(wait=UNCUT_WAIT_SECONDS)
        if homework is not None:
            told = asyncio.Event()
            self._reading = told
            self._in_background(self._look_at_the_homework(frame, *homework, told))
            return True
        self.session.generate_reply(user_input=SHOWN_WORK[self._language])
        return True

    def _homework_wanted(self) -> tuple[Reader, Engine] | None:
        """The reader and the engine, when the engine waits for a photo of
        the homework and there is a reader for it."""
        if self._awaits != "homework_photo" or self._reader is None or self._engine is None:
            return None
        return self._reader, self._engine

    async def _look_at_the_homework(
        self, frame: rtc.VideoFrame, reader: Reader, engine: Engine, told: asyncio.Event
    ) -> None:
        """Reads a photo of the homework for the engine, which waits for one.

        «Veamos.» is said at once, while the reader looks; nothing keeps the
        photo once it was read. The engine is then told what it showed, and
        ``told`` is set for what the student says next. Then its lines are
        said, or, when it could not be told, a fixed line that asks for the
        photo again. Nothing the reader's model wrote is said. Never raises."""
        try:
            looking = self.session.say(
                reply("meanwhile_look", self._language),
                add_to_chat_ctx=True,
                allow_interruptions=True,
            )
            reading = await reader.read(frame)
            del frame
            answer = await engine.homework(reading)
            if answer is not None:
                self._awaits = answer.awaits
            told.set()
            await looking
            if answer is None:
                await self.session.say(
                    reply("homework_unreachable", self._language),
                    add_to_chat_ctx=True,
                    allow_interruptions=True,
                )
                return
            if answer.lines:
                await self._say(answer.lines)
            if answer.closed:
                self.session.shutdown()
        except Exception as error:
            # The type only: what was read is not logged.
            logger.warning("homework photo not answered", extra={"error": type(error).__name__})
        finally:
            told.set()

    async def _after_the_photo(self) -> None:
        """Waits, for a while at most, for a photo of the homework being read
        to reach the engine, so that what the student says now comes after it."""
        told = self._reading
        if told is None or told.is_set():
            return
        with contextlib.suppress(TimeoutError):
            async with asyncio.timeout(HOMEWORK_WAIT_SECONDS):
                await told.wait()

    async def _interrupt(self, wait: float | None = None) -> None:
        """Stops what the tutor is saying, once it may be stopped.

        A line said with ``allow_interruptions=False`` (a gate's reply,
        "unavailable", pace's lines) cannot be cut: interrupting it raises, and
        the message typed or the work shown that asked for it would be lost,
        though the page already shows it as sent. Such a line is heard to its
        end first, and so is the next if it is another. After ``wait`` seconds
        of such lines nothing is cut: what comes next is queued behind them.
        """
        try:
            async with asyncio.timeout(wait):
                while (
                    (speech := self.session.current_speech) is not None
                    and not speech.done()
                    and not speech.allow_interruptions
                ):
                    await speech.wait_for_playout()
        except TimeoutError:
            return
        await self.session.interrupt()

    def _frame_for(self, chat_ctx: llm.ChatContext) -> rtc.VideoFrame | None:
        """The image that goes with this turn, if any: what the student just
        showed with the button, or what the camera sees when their words say
        they are showing something. The button's frame is used once."""
        frame = self._peek_frame(chat_ctx)
        self._shown = None
        return frame

    def _peek_frame(self, chat_ctx: llm.ChatContext) -> rtc.VideoFrame | None:
        if self._shown is not None:
            return self._shown
        if self._camera is not None and shows_something(chat_ctx):
            return self._camera.latest()
        return None

    def _ask_early(self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage) -> None:
        """Asks the model for this turn's reply while the gates judge it, with
        the request LiveKit makes once they let it through: the turn's
        conversation with its message inserted and the instructions marked,
        as the tutor holds them, and the tutor's tools and prompt. Not with
        the session engine, which reads the turn first and may change the
        rules, and not for a turn that takes a camera frame: no image goes to
        the model before the gates let its turn through.

        Nor while an exercise is open. An answer to it is checked once the
        gates let the turn through (``_check_after_the_gates``), never
        before, and the reply is then asked with the check in it: a request
        made now could not hold it, and would be paid for and dropped. Whether
        one is open is the checker's own state; the turn's words are not read
        for it."""
        self._drop_early_reply()
        if not self._asks_early or self._engine is not None or self._given_up:
            return
        if self._checker is not None and self._checker.exercise is not None:
            return
        chat_ctx = turn_ctx.copy()
        chat_ctx.insert(new_message)
        if self._peek_frame(chat_ctx) is not None:
            return
        mark_instructions_cache_boundary(chat_ctx)
        prompt = self._prompt()
        chat_ctx = with_instructions(chat_ctx, prompt.text)
        tools = llm.ToolContext(self.tools).flatten()
        settings = ModelSettings()
        times = HeldTimes()

        def stream() -> AsyncIterable[Any]:
            return timed(Agent.default.llm_node(self, chat_ctx, tools, settings), times)

        self._early = EarlyReply(
            stream,
            chat_ctx=chat_ctx,
            tool_ids=[tool.id for tool in tools],
            tool_choice=settings.tool_choice,
            prompt=prompt,
            tool_start=ToolStart(times),
            times=times,
        )

    def _drop_early_reply(self) -> None:
        if self._early is not None:
            self._early.drop()
            self._early = None
            self.early_replies["dropped"] += 1

    async def _may_answer(self, turn_ctx: llm.ChatContext, new_message: llm.ChatMessage) -> bool:
        """Judges what the person said or typed. When it must not reach the
        model, says the fixed reply for it and answers False."""
        # Read and reset before waiting, so a cancelled or safe turn starts the
        # sequence of reminders over.
        hazards, self._hazards_in_a_row = self._hazards_in_a_row, 0
        took = self._took()
        started = time.monotonic()
        decision = await self._gates.heard(turn_ctx, new_message)
        took("gates_in", time.monotonic() - started)
        if decision.allowed:
            return True
        # Before the fixed line is said, the model's request for this turn
        # stops: nothing it wrote goes on.
        early = self._early
        self._drop_early_reply()
        if early is not None:
            await early.closed(EARLY_REPLY_CLOSE_SECONDS)
        key = decision.reply or "unavailable"
        if key == "adult_help":
            key = ADULT_HELP_SEQUENCE[hazards]
        speech = await self.session.say(
            reply(key, self._language), add_to_chat_ctx=key in ANSWERABLE, allow_interruptions=False
        )
        if decision.reply == "adult_help" and not speech.interrupted:
            # After the full reply, alternate the two shorter reminders.
            self._hazards_in_a_row = hazards + 1 if hazards + 1 < len(ADULT_HELP_SEQUENCE) else 1
        return False

    @property
    def words_in_flight(self) -> bool:
        """Whether the hearing heard the student start or go on speaking after
        its last final transcript, so that a final may still be on its way.
        Flags only: the words are not kept."""
        return self._words_in_flight

    def hold_started(self) -> None:
        """The talk button went down: what was heard before is not this turn's,
        and neither is a reply asked for an earlier one, or its voice."""
        self._words_in_flight = False
        self._drop_early_reply()
        self._drop_voice()

    def _give_voice(self, text: str, whole: bool) -> None:
        """Gives the voice the beginning of what may be said next (``HeldVoice``),
        in place of whatever it was given before."""
        self._drop_voice()
        # Only a voice that streams can be given the beginning of a text and
        # the rest of it later.
        if self._voice is None or not self._voice.capabilities.streaming:
            return
        try:
            session = self.session
        except RuntimeError:
            return
        if not session.output.audio_enabled:
            return
        held = HeldVoice(
            self._voice, text, whole=whole, conn_options=session.conn_options.tts_conn_options
        )
        held.expiry = asyncio.get_running_loop().call_later(
            HELD_VOICE_SECONDS, self._expire_voice, held
        )
        self._held = held

    def _approve_voice(self, text: str) -> None:
        """``text`` may be said now: what the voice made of its beginning may be
        heard, if that is what it was given."""
        held = self._held
        if held is not None and held.fits(text):
            held.approved = True
        else:
            self._drop_voice()

    def _drop_voice(self) -> None:
        """Whatever the voice was given ahead is not going to be said."""
        held, self._held = self._held, None
        if held is not None:
            self.voiced_ahead["sentences_dropped"] += 1
            self._in_background(held.aclose())

    def _expire_voice(self, held: HeldVoice) -> None:
        if self._held is held:
            self._drop_voice()

    async def stt_node(
        self, audio: AsyncIterable[rtc.AudioFrame], model_settings: ModelSettings
    ) -> AsyncIterable[stt.SpeechEvent]:
        async for event in Agent.default.stt_node(self, self._listened(audio), model_settings):
            words = bool(event.alternatives and event.alternatives[0].text)
            if event.type == stt.SpeechEventType.START_OF_SPEECH or (
                event.type == stt.SpeechEventType.INTERIM_TRANSCRIPT and words
            ):
                self._words_in_flight = True
            final = event.type == stt.SpeechEventType.FINAL_TRANSCRIPT
            if final and words:
                self._words_in_flight = False
            if final and event.alternatives and self._timing is not None:
                self._timing.heard(event.alternatives[0].confidence)
                if words:
                    self._timing.final_heard()
            yield event

    async def _listened(
        self, audio: AsyncIterable[rtc.AudioFrame]
    ) -> AsyncIterable[rtc.AudioFrame]:
        """The student's audio on its way to speech to text. A copy of its last
        seconds is kept in memory only while a drill is open, for its measure."""
        async for frame in audio:
            if self._drill.open:
                samples = np.frombuffer(frame.data, dtype=np.int16)[:: frame.num_channels]
                self._drill.hear(samples.copy(), frame.sample_rate)
            yield frame

    def _took(self) -> Took:
        """Where the stages measured from now on are reported: the staged
        turn open now, whatever turn is open when each one ends."""
        timing = self._timing
        if timing is None:
            return lambda stage, seconds: None
        turn = timing.turn
        return lambda stage, seconds: timing.took(stage, seconds, turn)

    async def tts_node(
        self, text: AsyncIterable[str], model_settings: ModelSettings
    ) -> AsyncIterable[rtc.AudioFrame]:
        """The voice of what is said: made ahead when it could be, by the voice
        otherwise.

        LiveKit hands this node text only once it may be said: a reply after
        ``checked`` released it, a fixed line or a line of the script. Read
        far enough to tell, text that begins with what the voice made ahead
        and was approved for (``HeldVoice``) is said with it, and so is a line
        said while a tool works that was made when the session began.
        """
        took = self._took()
        chunks = aiter(text)
        start, ended, sent_at = "", True, 0.0
        async for chunk in chunks:
            sent_at = sent_at or time.monotonic()
            start += chunk
            if not self._may_be_voiced_ahead(start):
                ended = False
                break
        held = self._held
        line = self._lines_voiced.get(start.strip()) if ended else None
        frames: AsyncIterable[rtc.AudioFrame]
        if held is not None and held.approved and held.fits(start) and (ended or not held.whole):
            self._held = None
            self.voiced_ahead["sentences_said"] += 1
            frames = held.frames(_then(start.lstrip()[len(held.given) :], chunks))
        elif line is not None:
            self.voiced_ahead["lines_said"] += 1
            held, frames = None, _replayed(line)
        else:
            held, frames = None, Agent.default.tts_node(self, _then(start, chunks), model_settings)
        first = True
        async with contextlib.aclosing(frames):  # type: ignore[type-var]
            async for frame in frames:
                if first:
                    first = False
                    if held is not None and held.first_audio is not None:
                        # The voice's own time, from the moment it got the text.
                        took("tts_ttfb", held.first_audio)
                    elif held is None and line is None and sent_at:
                        took("tts_ttfb", time.monotonic() - sent_at)
                yield frame

    def _may_be_voiced_ahead(self, start: str) -> bool:
        """Whether more of a text that begins with ``start`` could still make it
        one the voice made ahead (a whole one has to end where it ends)."""
        text = start.lstrip()
        held = self._held
        if held is not None and held.approved:
            if held.whole and held.given.rstrip().startswith(text.rstrip()):
                return True
            if not held.whole and len(text) < len(held.given) and held.given.startswith(text):
                return True
        return any(line.startswith(text.rstrip()) for line in self._lines_voiced)

    async def llm_node(
        self, chat_ctx: llm.ChatContext, tools: list[llm.Tool], model_settings: ModelSettings
    ) -> AsyncIterable[llm.ChatChunk | str]:
        """One step of the model, as it reaches the voice (``_said``).

        A step that fails, or is not over within ``STEP_SECONDS``, is asked
        once more after a fixed line, so the student is not left in silence.
        One that fails again, or in a way no retry changes, gives the model up
        for the session, which closes with a fixed line (``_failed``). Nothing
        of a failed step was said but a fixed line: ``checked`` holds a step
        whole until it is over, and the tutor always has tools.
        """
        took = self._took()
        prompt = self._prompt()
        # A new step: what the voice was given for an earlier one is not said now.
        self._drop_voice()
        # Read by the model's client as the request is laid out (``providers``),
        # with the instructions as they are now.
        REQUEST.set(prompt)
        chat_ctx = with_instructions(chat_ctx, prompt.text)
        early, self._early = self._early, None
        if early is not None and (
            self._given_up
            or not early.matches(
                chat_ctx, tools, model_settings, prompt, self._peek_frame(chat_ctx)
            )
        ):
            early.drop()
            self.early_replies["dropped"] += 1
            early = None
        if self._given_up:
            # The session is closing: the model is not asked again.
            return
        frame = None if early is not None else self._frame_for(chat_ctx)
        try:
            while True:
                if early is not None:
                    # The gates let the turn through and this is the request the
                    # early reply made: what the model wrote so far, then the
                    # rest, and the stages it timed.
                    early.request.used = True
                    early.times.tell(took)
                    self.early_replies["used"] += 1
                    stream, tool_start = early.chunks(), early.tool_start
                else:
                    # Read by the model's client as the model's events come in.
                    tool_start = ToolStart(took)
                    TOOL_STARTED.set(tool_start)
                    stream = timed(
                        Agent.default.llm_node(
                            self, with_frame(chat_ctx, frame), tools, model_settings
                        ),
                        took,
                    )
                said = self._said(_in_time(stream, STEP_SECONDS), tools, took, tool_start.began)
                failure: Exception | None = None
                try:
                    async with contextlib.aclosing(said):  # type: ignore[type-var]
                        async for chunk in said:
                            yield chunk
                except Exception as error:
                    failure = error
                if failure is None:
                    self._failures = 0
                    return
                if early is not None:
                    # Asked again, the request is a new one.
                    early.drop()
                    early = None
                if not self._failed(failure):
                    return
                if line := self._hold_on():
                    # On its own, so the voice says it while the step is asked again.
                    yield line
                    yield FlushSentinel()
        finally:
            if early is not None:
                # Interrupted while it still ran: the request stops.
                early.drop()

    async def _said(
        self,
        stream: AsyncIterable[Any],
        tools: list[llm.Tool],
        took: Took,
        tool_began: asyncio.Event | None = None,
    ) -> AsyncIterable[llm.ChatChunk | str]:
        """What reaches the voice from one step of the model: through the
        output gate, with a word for a drawing that had none."""
        if tools or self._gates.checks_spoken:
            # Buffering costs the time to the first word, so it is only paid
            # when there is a gate to wait for or a tool whose step must be
            # known whole before any of it is said.
            stream = checked(
                stream,
                self._gates,
                self._language,
                self._meanwhile if tools else None,
                took=took,
                ahead=self._ahead,
                tool_began=tool_began,
            )
        started = time.monotonic()
        chars, called = 0, []
        async with contextlib.aclosing(stream):  # type: ignore[type-var]
            async for chunk in stream:
                chars += len(_text_of(chunk))
                delta = getattr(chunk, "delta", None)
                called += [call.name for call in (delta.tool_calls if delta else None) or []]
                yield chunk
        if not chars and not called and self._drew:
            # The model put its words in the steps that drew, which are not
            # said, and had nothing left for the last one: the student would
            # hear only "a ver" and see a drawing.
            line = reply("look_at_screen", self._language)
            chars = len(line)
            yield line
        self._model_done_at = time.monotonic()
        # Counts only: what was said is never logged.
        logger.info(
            "tutor reply",
            extra={
                "chars": chars,
                "tools": called,
                "seconds": round(self._model_done_at - started, 1),
            },
        )
