"""The tutor: what it is told to be, and where the gates and the camera plug in."""

import asyncio
import contextlib
import itertools
import json
import logging
import re
import time
from collections.abc import AsyncIterable, Awaitable, Callable
from dataclasses import dataclass
from typing import Any, Protocol

import numpy as np
from livekit import rtc
from livekit.agents import Agent, ModelSettings, StopResponse, function_tool, llm, stt
from livekit.agents.voice.generation import INSTRUCTIONS_MESSAGE_ID

from . import comparison, drill, farewell, visuals
from .greetings import greeting as written_greeting
from .prompts import CHECKING, INSTRUCTIONS, PACED, SCREEN, response_language
from .providers import REQUEST, Prompt
from .replies import ADULT_HELP_SEQUENCE, ANSWERABLE, MEANWHILE, reply
from .safety import Gates
from .script import Engine, Line, Reply
from .timing import Timing

logger = logging.getLogger("aule.agent.tutor")

# Sends one visual to the student's screen.
Show = Callable[[dict[str, Any]], Awaitable[None]]


class Checker(Protocol):
    """Checks the student's answers without the model: the platform."""

    async def pose(self, expression: str, skill_id: str | None, form: str | None) -> str | None: ...

    async def answer(self, said: str) -> str | None: ...


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

# How long after an accepted turn a missing reply is reported. A reply normally
# starts within four seconds; the model may have begun it before the turn was
# accepted, hence the allowance.
NO_REPLY_SECONDS = 15.0
EARLY_REPLY_SECONDS = 5.0

# The longest typed message that is read. A spoken turn is rarely longer.
MAX_TYPED_CHARS = 500

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


async def checked(
    stream: AsyncIterable[Any],
    gates: Gates,
    language: str,
    meanwhile: Callable[[], str] | None = None,
    *,
    took: Took | None = None,
) -> AsyncIterable[Any]:
    """What reaches the voice from one step of the model.

    A step that calls a tool is work, not talk: every tool answers with what
    to say next, and what the model writes on its way there is its own
    reasoning ("the plan says start easy, so I show the bars before asking",
    "there is an exercise open, so I check what they said") or words said too
    soon. None of it is spoken. What ``meanwhile`` gives is said in its place:
    one short fixed line, so the student is not left in silence while the tool
    works, or nothing when the turn already had its line.

    Any other step is the reply. Nothing of it reaches the voice before the
    gate on what is spoken has approved all of it: a safe beginning says
    nothing about how a sentence ends. A reply that does not pass is replaced
    by a fixed one.
    """
    chunks = [chunk async for chunk in stream]
    if any(_calls_of(chunk) for chunk in chunks):
        left_out = sum(len(_text_of(chunk)) for chunk in chunks)
        if left_out:
            # Counts only: what was left out is never logged.
            logger.info(
                "nothing of the model's said in a step with a tool", extra={"chars": left_out}
            )
        line = meanwhile() if meanwhile is not None else ""
        if line:
            yield line
        for chunk in chunks:
            if not _text_of(chunk):
                yield chunk
        return
    if not gates.checks_spoken:
        for chunk in chunks:
            yield chunk
        return
    written = "".join(_text_of(chunk) for chunk in chunks)
    # A paragraph break is not a reasoning boundary: it may separate the
    # example from its question. Provider thinking is a separate stream type,
    # and tool-step text is suppressed above. Judge the whole final reply.
    started = time.monotonic()
    decision = await gates.spoken(written)
    if took is not None:
        took("gate_out", time.monotonic() - started)
    if not decision.allowed:
        yield reply(decision.reply or "unavailable", language)
    else:
        for chunk in chunks:
            yield chunk


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
        breaks: bool = False,
        timing: Timing | None = None,
    ) -> None:
        # `context` is what the platform knows about this student and the
        # supervisor's plan for the session; empty when there is no platform.
        # `show` is given when the student has a screen to draw on.
        # `checker` judges answers to computations, so the model neither has to
        # work them out nor holds the answer of an exercise that is still open.
        # `student_name` and `session_number` only choose and fill the greeting.
        # `engine` is the session engine: what it wrote is said as written, and
        # the model speaks only when the student leaves the script.
        # `persona` is the tutor's name, tone preset and (already-moderated)
        # family note; the default leaves the prompt exactly as written.
        persona = persona or Persona()
        instructions = INSTRUCTIONS

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
                return (
                    await checker.pose(
                        expression,
                        skill_id if isinstance(skill_id, str) else None,
                        form if isinstance(form, str) else None,
                    )
                    or UNCHECKED
                )

            @function_tool(raw_schema=CHECK_ANSWER)
            async def check_answer(raw_arguments: dict[str, object]) -> str:
                said = raw_arguments.get("said")
                if not isinstance(said, str) or not said.strip():
                    return UNCHECKED
                return await checker.answer(said) or UNCHECKED

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
        self._engine = engine
        # Which answer of the engine is being said. Lines of an older one stop
        # as soon as a newer answer arrives.
        self._script_turn = 0
        self._show = show
        self._model_done_at = 0.0
        self._watches: set[asyncio.Task[None]] = set()
        self._tutor_name = persona.name
        self._student_name = student_name
        self._session_number = session_number
        # What closes the session when the student says goodbye; set by the
        # worker, which owns the session's pace.
        self.on_goodbye: Callable[[], None] | None = None

    def _goodbye(self, text: str) -> bool:
        """Whether this turn was the student's goodbye, and the session now closes."""
        if self.on_goodbye is None or not farewell.said_goodbye(text):
            return False
        self.on_goodbye()
        return True

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
        opening = self._engine.opening() if self._engine is not None else ()
        if opening:
            await self._say(opening)
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
            await self.session.say(line.say, add_to_chat_ctx=True, allow_interruptions=True)
            said += 1
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
        reply = await self._engine.said(text)
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
        self._meanwhile_due = True
        self._drew = False
        # A spoken turn during a drill is the student's try (a typed one never comes here).
        self._drill.took()
        if not await self._may_answer(turn_ctx, new_message):
            # The stopped turn never reaches the model: StopResponse discards it.
            raise StopResponse()
        if self._goodbye(new_message.text_content or ""):
            raise StopResponse()
        if await self._scripted(new_message.text_content or ""):
            # The engine answered. The student's words stay in the conversation;
            # the model is not asked.
            turn_ctx.items.append(new_message)
            await self.update_chat_ctx(turn_ctx)
            raise StopResponse()
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

    async def typed(self, text: str) -> None:
        """A message typed instead of spoken.

        It is judged like a spoken turn before the model sees it. Without this
        a typed message would go straight to the model, past both input gates.
        """
        text = text.strip()[:MAX_TYPED_CHARS]
        if not text:
            return
        self._meanwhile_due = True
        self._drew = False
        await self._interrupt()
        message = llm.ChatMessage(role="user", content=[text])
        if not await self._may_answer(self.chat_ctx.copy(), message):
            return
        if self._goodbye(text):
            return
        if await self._scripted(text):
            context = self.chat_ctx.copy()
            context.items.append(message)
            await self.update_chat_ctx(context)
            return
        self.session.generate_reply(user_input=text)

    def _meanwhile(self) -> str:
        if not self._meanwhile_due:
            return ""
        self._meanwhile_due = False
        return reply(next(self._meanwhiles), self._language)

    async def show_work(self) -> bool:
        """The student pressed the button that shows their work: the tutor
        looks at what the camera sees now and answers at once. False when the
        camera sent nothing to look at, and then nothing is said."""
        if self._camera is None:
            return False
        frame = await self._camera.fresh(FRESH_FRAME_SECONDS)
        if frame is None:
            return False
        self._shown = frame
        self._meanwhile_due = True
        self._drew = False
        # The page is waiting for this answer: a long line that cannot be cut is
        # not waited for to its end, and the reply is said after it instead.
        await self._interrupt(wait=UNCUT_WAIT_SECONDS)
        self.session.generate_reply(user_input=SHOWN_WORK[self._language])
        return True

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
        they are showing something."""
        frame, self._shown = self._shown, None
        if frame is None and self._camera is not None and shows_something(chat_ctx):
            frame = self._camera.latest()
        return frame

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
        """The talk button went down: what was heard before is not this turn's."""
        self._words_in_flight = False

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
        took = self._took()
        sent: list[float] = []

        async def watched() -> AsyncIterable[str]:
            async for chunk in text:
                if not sent:
                    sent.append(time.monotonic())
                yield chunk

        first = True
        frames = Agent.default.tts_node(self, watched(), model_settings)
        async with contextlib.aclosing(frames):
            async for frame in frames:
                if first and sent:
                    took("tts_ttfb", time.monotonic() - sent[0])
                first = False
                yield frame

    async def llm_node(
        self, chat_ctx: llm.ChatContext, tools: list[llm.Tool], model_settings: ModelSettings
    ) -> AsyncIterable[llm.ChatChunk | str]:
        took = self._took()
        prompt = self._prompt()
        # Read by the model's client as the request is laid out (``providers``),
        # with the instructions as they are now.
        REQUEST.set(prompt)
        chat_ctx = with_instructions(chat_ctx, prompt.text)
        frame = self._frame_for(chat_ctx)
        stream = timed(
            Agent.default.llm_node(self, with_frame(chat_ctx, frame), tools, model_settings), took
        )
        if tools or self._gates.checks_spoken:
            # Buffering costs the time to the first word, so it is only paid
            # when there is a gate to wait for or a tool whose step must be
            # known whole before any of it is said.
            stream = checked(
                stream, self._gates, self._language, self._meanwhile if tools else None, took=took
            )
        started = time.monotonic()
        chars, called = 0, []
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
