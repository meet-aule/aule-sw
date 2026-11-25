"""How the tutor's model is called: the real plugin and the real client
wrapper, with the Anthropic client stood in for (``fakes``). The stand-in
refuses what the real API would answer 400 to and bills prompt-cache reads
the way the API does. No network and no paid calls."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import patch

import anthropic
import pytest
from fakes import CURRENT_WORLD, THOUGHT, Delays, TurnPlan, World
from livekit.agents import Agent, llm
from livekit.agents.utils import is_given

from aule_agent.config import Settings
from aule_agent.prompts import response_language
from aule_agent.providers import (
    EARLY,
    REQUEST,
    TOOL_STARTED,
    WARMING,
    Early,
    Prompt,
    PromptLayout,
    build_llm,
    layout,
)
from aule_agent.tutor import WARM_UP, Tutor
from aule_agent.usage import Usage

ENV = {
    "LIVEKIT_URL": "ws://127.0.0.1:7880",
    "LIVEKIT_API_KEY": "key",
    "LIVEKIT_API_SECRET": "secret",
    "ANTHROPIC_API_KEY": "sk-ant-test",
    "AULE_STT": "deepgram",
    "DEEPGRAM_API_KEY": "dg",
    "AULE_TTS": "cartesia",
    "CARTESIA_API_KEY": "car",
}
AFTER_HISTORY = {**ENV, "AULE_NOTES_AFTER_HISTORY": "1"}
# Where the notes go: ending the system prompt (as before), or after the history.
PLACEMENTS = pytest.mark.parametrize("env", [ENV, AFTER_HISTORY], ids=["system", "after_history"])
RULES = "Eres Aule. " * 300
STUDENT = "Lo que sabemos: cuarto grado. " * 120


class Gates:
    checks_spoken = True


class Checker: ...


async def screen(visual): ...


@pytest.fixture
def world(monkeypatch):
    world = World(seed=1, delays=Delays(scale=0.001))
    token = CURRENT_WORLD.set(world)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-test")
    monkeypatch.setattr(anthropic, "AsyncClient", lambda **options: world.model_client)
    yield world
    CURRENT_WORLD.reset(token)


def tools():
    return Tutor(language="es", gates=Gates(), show=screen, checker=Checker(), breaks=True).tools


async def ask(model, chat_ctx, prompt, tool_list):
    """One request as the tutor makes it: its prompt read by the client, and
    the instructions handed over as the tutor holds them, the prompt's whole
    text (``Tutor.llm_node``)."""
    REQUEST.set(prompt)
    first = chat_ctx.items[0]
    if first.type == "message" and first.role == "system":
        chat_ctx.items[0] = llm.ChatMessage(role="system", content=[prompt.text], id=first.id)
    async with model.chat(chat_ctx=chat_ctx, tools=tool_list) as stream:
        return [chunk async for chunk in stream]


def plain(request):
    """A request without its cache markers and without the notes, as JSON."""

    def strip(value):
        if isinstance(value, dict):
            return {k: strip(v) for k, v in value.items() if k != "cache_control"}
        if isinstance(value, list):
            return [strip(item) for item in value]
        return value

    # The notes are an unmarked last system block, or a system message.
    system = [block for block in request.get("system") or [] if "cache_control" in block]
    messages = [m for m in request["messages"] if m["role"] != "system"]
    return {
        "tools": strip(request.get("tools")),
        "system": strip(system),
        "messages": strip(messages),
    }


def markers(request):
    """Where the cache markers are: ("tools", i), ("system", i), (message, block)."""
    found = [
        ("tools", i) for i, tool in enumerate(request.get("tools") or []) if "cache_control" in tool
    ]
    found += [
        ("system", i)
        for i, block in enumerate(request.get("system") or [])
        if "cache_control" in block
    ]
    for m, message in enumerate(request["messages"]):
        content = message["content"]
        if isinstance(content, list):
            found += [(m, b) for b, block in enumerate(content) if "cache_control" in block]
    return found


async def conversation(model, world):
    """Five requests of one session: guidance arrives, the step after a
    tool, a late plan, the engine's rules for one moment."""
    tool_list = tools()
    chat = llm.ChatContext()
    chat.add_message(role="system", content=Prompt(RULES, STUDENT).system)
    chat.add_message(role="assistant", content="¡Hola! ¿Cómo te fue hoy?")
    chat.add_message(role="user", content="bien, estudié fracciones")
    await ask(model, chat, Prompt(RULES, STUDENT), tool_list)

    chat.add_message(role="assistant", content="¡Qué bien! ¿Cuánto es tres cuartos más un octavo?")
    chat.add_message(role="user", content="siete octavos")
    guided = Prompt(RULES, STUDENT, notes="Guía 1: pide que explique su idea.")
    await ask(model, chat, guided, tool_list)

    chat.items.append(
        llm.FunctionCall(call_id="c1", name="check_answer", arguments='{"said": "siete octavos"}')
    )
    chat.items.append(
        llm.FunctionCallOutput(call_id="c1", name="check_answer", output="Right.", is_error=False)
    )
    await ask(model, chat, guided, tool_list)

    late = Prompt(RULES, STUDENT + " Plan tardío: barras.", notes=guided.notes)
    chat.add_message(role="assistant", content="¡Correcto! Muy bien pensado.")
    chat.add_message(role="user", content="¿y ahora qué hacemos?")
    await ask(model, chat, late, tool_list)

    chat.add_message(role="assistant", content="Ahora una medición, sin pistas.")
    chat.add_message(role="user", content="vale")
    engine = Prompt(late.rules, late.student, notes="No hints: this is a measurement.")
    await ask(model, chat, engine, tool_list)
    return [call.kwargs for call in world.model_calls]


@PLACEMENTS
async def test_every_request_is_one_the_api_takes(world, env):
    requests = await conversation(build_llm(Settings.from_env(env)), world)

    assert len(requests) == 5 and world.api_errors == []


@PLACEMENTS
async def test_the_rules_never_change_and_the_students_part_only_with_a_late_plan(world, env):
    requests = await conversation(build_llm(Settings.from_env(env)), world)

    rules = {json.dumps(r["system"][0], ensure_ascii=False) for r in requests}
    student = [r["system"][1]["text"] for r in requests]
    assert len(rules) == 1 and requests[0]["system"][0]["text"] == RULES
    # Guidance, the step after a tool and the engine's rules leave it as it was.
    assert student[0] == student[1] == student[2] and student[3] == student[4]
    assert student[2] != student[3]


@PLACEMENTS
async def test_each_request_is_the_one_before_it_with_more_history(world, env):
    requests = await conversation(build_llm(Settings.from_env(env)), world)

    for before, after in zip(requests, requests[1:], strict=False):
        older, newer = plain(before), plain(after)
        assert newer["tools"] == older["tools"]
        assert newer["messages"][: len(older["messages"])] == older["messages"]
        if older["system"] != newer["system"]:
            # The late plan: the rules, ahead of it, are still the same.
            assert newer["system"][0] == older["system"][0]


@PLACEMENTS
async def test_at_most_four_markers_on_the_system_blocks_and_the_newest_history(world, env):
    requests = await conversation(build_llm(Settings.from_env(env)), world)

    for index, request in enumerate(requests):
        found = markers(request)
        assert len(found) <= 4
        assert ("system", 0) in found and ("system", 1) in found
        assert not any(where == "tools" for where, _ in found)
        history = [m for m in request["messages"] if m["role"] != "system"]
        newest = max(i for i, m in enumerate(history) if m["role"] == "user")
        assert (newest, len(history[newest]["content"]) - 1) in found
        if index:
            # The message that ended the previous request is read back.
            ended = len(plain(requests[index - 1])["messages"]) - 1
            assert ended == newest or (ended, len(history[ended]["content"]) - 1) in found


async def test_the_notes_end_the_system_prompt_unmarked_and_are_not_kept(world):
    requests = await conversation(build_llm(Settings.from_env(ENV)), world)

    assert [len(r["system"]) for r in requests] == [2, 3, 3, 3, 3]
    assert [r["system"][-1]["text"] for r in requests[1:]] == [
        "Guía 1: pide que explique su idea.",
        "Guía 1: pide que explique su idea.",
        "Guía 1: pide que explique su idea.",
        "No hints: this is a measurement.",
    ]
    assert all("cache_control" not in r["system"][2] for r in requests[1:])
    assert all(m["role"] != "system" for r in requests for m in r["messages"])


async def test_after_the_history_the_notes_are_a_system_message_and_are_not_kept(world):
    requests = await conversation(build_llm(Settings.from_env(AFTER_HISTORY)), world)

    notes = [r["messages"][-1] for r in requests]
    assert notes[0]["role"] == "user"  # no notes yet
    assert [n["content"] for n in notes[1:]] == [
        "Guía 1: pide que explique su idea.",
        "Guía 1: pide que explique su idea.",
        "Guía 1: pide que explique su idea.",
        "No hints: this is a measurement.",
    ]
    assert all(n["role"] == "system" for n in notes[1:])
    # The next request does not carry the last one's notes in its history.
    assert all(m["role"] != "system" for r in requests for m in r["messages"][:-1])


@PLACEMENTS
async def test_tool_choice_is_the_same_on_every_call(world, env):
    requests = await conversation(build_llm(Settings.from_env(env)), world)

    assert [r["tool_choice"] for r in requests] == [{"type": "auto"}] * 5


def read_shares(world):
    return [
        call.cache_read / (call.cache_read + call.cache_write + call.uncached)
        for call in world.model_calls
    ]


async def test_new_guidance_still_reads_the_tools_the_rules_and_the_students_part(world):
    await conversation(build_llm(Settings.from_env(ENV)), world)
    shares = read_shares(world)

    # The first call writes; new notes read all but the history; the step
    # after a tool, with the same notes, reads the history too; the late plan
    # reads the tools and the rules.
    assert shares[0] == 0
    assert shares[1] > 0.85 and shares[4] > 0.85
    assert shares[2] > 0.9
    assert shares[3] > 0.4


async def test_after_the_history_new_notes_leave_the_whole_history_cached(world):
    await conversation(build_llm(Settings.from_env(AFTER_HISTORY)), world)
    shares = read_shares(world)

    assert shares[0] == 0
    for index in (1, 2, 4):
        assert shares[index] > 0.9, index
    assert shares[3] > 0.4


async def test_a_model_that_takes_no_system_message_keeps_the_notes_in_the_system_prompt(world):
    other = Settings.from_env({**AFTER_HISTORY, "AULE_LLM_MODEL": "claude-opus-5-5"})

    requests = await conversation(build_llm(other), world)

    assert world.api_errors == []
    assert [r["system"][-1]["text"] for r in requests[1:]][-1] == (
        "No hints: this is a measurement."
    )
    assert "cache_control" not in requests[-1]["system"][-1]
    assert all(m["role"] != "system" for r in requests for m in r["messages"])


async def test_no_thinking_block_is_ever_sent_back(world):
    # The plugin keeps no thinking blocks: after an edit of the history (the
    # notes are not kept) a replayed one would be a 400 with between_tools.
    world.thinking = "always"
    model = build_llm(Settings.from_env(ENV))
    chat = llm.ChatContext()
    chat.add_message(role="system", content=RULES)
    chat.add_message(role="user", content="hola")
    said = await ask(model, chat, Prompt(RULES), [])
    # The reply as LiveKit adds it to the history: its words and what the
    # plugin handed over besides them (``ChoiceDelta.extra``).
    text = "".join(c.delta.content for c in said if c.delta and c.delta.content)
    extra = {k: v for c in said if c.delta and c.delta.extra for k, v in c.delta.extra.items()}
    assert world.model_calls[0].thought and text and THOUGHT not in text
    chat.add_message(role="assistant", content=text, extra=extra)
    chat.add_message(role="user", content="¿y ahora?")

    await ask(model, chat, Prompt(RULES, notes="Guía."), [])

    blocks = [
        block
        for call in world.model_calls
        for message in call.kwargs["messages"]
        if isinstance(message["content"], list)
        for block in message["content"]
    ]
    assert blocks and all(block.get("type") != "thinking" for block in blocks)
    assert world.api_errors == []


async def test_a_request_asked_early_writes_nothing_of_its_turn_and_is_not_built_on(world):
    model, tool_list = build_llm(Settings.from_env(ENV)), tools()
    chat = llm.ChatContext()
    chat.add_message(role="system", content=Prompt(RULES, STUDENT).system)
    chat.add_message(role="assistant", content="¡Hola! ¿Cómo te fue hoy?")
    chat.add_message(role="user", content="bien, estudié fracciones")
    await ask(model, chat, Prompt(RULES, STUDENT), tool_list)
    chat.add_message(role="assistant", content="¿Cuánto es tres cuartos más un octavo?")
    chat.add_message(role="user", content="siete octavos")

    async def early():
        # As ``tutor.EarlyReply`` asks, in a task of its own.
        EARLY.set(Early())
        await ask(model, chat, Prompt(RULES, STUDENT), tool_list)

    await asyncio.create_task(early())
    # The gates let the turn through and its reply was used; the next turn.
    chat.add_message(role="assistant", content="¡Correcto!")
    chat.add_message(role="user", content="¿y ahora qué hacemos?")
    await ask(model, chat, Prompt(RULES, STUDENT), tool_list)

    first, asked_early, after = world.model_calls
    ended = len(plain(first.kwargs)["messages"]) - 1
    turn = len(plain(asked_early.kwargs)["messages"]) - 1
    found = markers(asked_early.kwargs)
    # No marker on the turn's words: the cache is read up to the request before
    # and nothing of the turn is written to it.
    assert not [where for where in found if where[0] == turn]
    assert ("system", 1) in found and any(where[0] == ended for where in found)
    assert asked_early.cache_write == 0 and asked_early.cache_read > 0
    # The next request builds on the one before the early one, which it reads back.
    assert any(where[0] == ended for where in markers(after.kwargs))
    assert after.cache_read == asked_early.cache_read and world.api_errors == []


def test_the_plugin_calls_the_layout_around_its_own_client(world):
    model = build_llm(Settings.from_env(ENV))

    assert isinstance(model._client, PromptLayout)
    # The transport is the plugin's: the wrapped client is the one it built.
    assert model._client._client is world.model_client
    # The plugin places no markers of its own.
    assert not is_given(model._opts.caching)


async def test_a_client_the_model_is_given_is_laid_out_around_like_the_plugins_own(
    world, monkeypatch
):
    # The tutoring evaluation (evals/pedagogy) names the model and gives a
    # client of its own, which meters every call.
    def not_given(**options):
        raise AssertionError("the plugin built a client of its own")

    monkeypatch.setattr(anthropic, "AsyncClient", not_given)
    model = build_llm(SimpleNamespace(llm_model="claude-sonnet-5-5"), client=world.model_client)

    assert isinstance(model._client, PromptLayout)
    assert model._client._client is world.model_client
    requests = await conversation(model, world)
    assert len(requests) == 5 and world.api_errors == []
    assert [len(r["system"]) for r in requests] == [2, 3, 3, 3, 3]
    assert [r["tool_choice"] for r in requests] == [{"type": "auto"}] * 5
    assert all(m["role"] != "system" for r in requests for m in r["messages"])


def test_without_the_tutors_prompt_the_instructions_are_marked_as_they_are():
    request = {
        "model": "claude-sonnet-5-5",
        "system": [{"type": "text", "text": "instrucciones"}],
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hola"}]}],
    }

    sent, kept = layout(request, None, system_messages=True)

    assert sent["system"] == [
        {"type": "text", "text": "instrucciones", "cache_control": {"type": "ephemeral"}}
    ]
    assert kept == [{"role": "user", "content": [{"type": "text", "text": "hola"}]}]
    assert "tool_choice" not in sent


@pytest.mark.parametrize("system_messages", [False, True])
def test_instructions_that_are_not_the_prompts_text_go_whole_and_no_notes_are_added(
    system_messages,
):
    # Instructions older than the prompt (the tutor's node hands its own on):
    # sent as they are, marked at their end, and the newer notes are not
    # added to them a second time, in the system prompt or after the history.
    older = Prompt("reglas", "alumno", notes="Guía 1.")
    request = {
        "model": "claude-sonnet-5-5",
        "system": [{"type": "text", "text": older.text}],
        "messages": [{"role": "user", "content": [{"type": "text", "text": "hola"}]}],
    }

    newer = Prompt("reglas", "alumno", notes="Guía 2.")

    sent, _ = layout(request, newer, system_messages=system_messages)

    assert sent["system"] == [
        {"type": "text", "text": older.text, "cache_control": {"type": "ephemeral"}}
    ]
    assert [message["role"] for message in sent["messages"]] == ["user"]


def test_a_camera_frame_is_left_after_the_marker():
    image = {"type": "image", "source": {"type": "base64", "data": "x", "media_type": "image/png"}}
    request = {
        "model": "claude-sonnet-5-5",
        "messages": [{"role": "user", "content": [{"type": "text", "text": "mira"}, image]}],
    }

    sent, _ = layout(request, Prompt("reglas"), system_messages=True)

    text, frame = sent["messages"][0]["content"]
    assert "cache_control" in text and "cache_control" not in frame


def plugin_node(model):
    """LiveKit's default llm_node without a session: the real plugin's stream."""

    async def node(agent, chat_ctx, tool_list, settings):
        async with model.chat(chat_ctx=chat_ctx, tools=tool_list) as stream:
            async for chunk in stream:
                yield chunk

    return node


@pytest.mark.parametrize(
    "given, env",
    [(False, ENV), (True, None), (False, AFTER_HISTORY)],
    ids=["own_client", "given_client", "after_history"],
)
async def test_the_warm_up_writes_the_cache_the_first_reply_reads(world, given, env):
    model = (
        build_llm(SimpleNamespace(llm_model="claude-sonnet-5-5"), client=world.model_client)
        if given
        else build_llm(Settings.from_env(env))
    )
    usage = Usage()
    model.on("metrics_collected", usage.add)
    tutor = Tutor(language="es", gates=Gates(), context=STUDENT, show=screen, checker=Checker())
    with patch.object(Agent.default, "llm_node", side_effect=plugin_node(model)):
        await tutor.warm_the_model()
    # Its tokens are counted with the session's.
    assert usage.calls == 1 and usage.cache_write_tokens == world.model_calls[0].cache_write
    chat = llm.ChatContext()
    chat.add_message(role="system", content=tutor.instructions)
    chat.add_message(role="assistant", content="¡Hola! ¿Cómo te fue hoy?")
    chat.add_message(role="user", content="bien")
    await ask(model, chat, tutor._prompt(), tutor.tools)

    warm, first = world.model_calls
    sent, real = warm.kwargs, first.kwargs
    assert world.api_errors == []
    # Once, without streaming and without a word back.
    assert sent["stream"] is False and sent["max_tokens"] == 0
    # What a real call sends before the conversation, byte for byte.
    for key in ("tools", "system", "thinking", "tool_choice"):
        assert json.dumps(sent[key]) == json.dumps(real[key]), key
    assert markers(sent) == [("system", 0), ("system", 1)]
    # No student's words: a placeholder only. The notes, the output-language
    # rule last, come after the prefix as a reply's do: ending the system
    # prompt, or after the placeholder.
    placeholder = {"role": "user", "content": [{"type": "text", "text": WARM_UP}]}
    if env is AFTER_HISTORY:
        notes = {"role": "system", "content": response_language("es")}
        assert sent["messages"] == [placeholder, notes] and len(sent["system"]) == 2
    else:
        assert sent["messages"] == [placeholder]
        assert sent["system"][-1] == {"type": "text", "text": response_language("es")}
    # The first reply reads all of it from the cache.
    assert first.cache_read >= warm.cache_write > 0


async def test_a_warm_up_that_fails_is_nothing_and_a_cancelled_one_stops(world, caplog):
    tutor = Tutor(language="es", gates=Gates())

    async def broken(*_):
        raise RuntimeError("down")
        yield

    async def endless(*_):
        await asyncio.Event().wait()
        yield

    with caplog.at_level("INFO", logger="aule.agent.tutor"):
        with patch.object(Agent.default, "llm_node", side_effect=broken):
            await tutor.warm_the_model()
    assert [record.message for record in caplog.records] == ["model not warmed"]
    assert REQUEST.get() is None and not WARMING.get()

    with patch.object(Agent.default, "llm_node", side_effect=endless):
        task = asyncio.create_task(tutor.warm_the_model())
        await asyncio.sleep(0.01)
        task.cancel()
        with pytest.raises(asyncio.CancelledError):
            await task


async def written(model, words, told=None):
    """What the plugin hands over for one request, and what the client was told."""
    chat = llm.ChatContext()
    chat.add_message(role="system", content=RULES)
    chat.add_message(role="user", content=words)
    token = TOOL_STARTED.set(told)
    try:
        return await ask(model, chat, Prompt(RULES), tools())
    finally:
        TOOL_STARTED.reset(token)


def kept(chunks):
    """What the plugin handed over: the text and the calls, in order."""
    return [
        (chunk.delta.content, [(c.name, c.arguments) for c in chunk.delta.tool_calls or []])
        for chunk in chunks
        if chunk.delta is not None
    ]


async def test_the_client_tells_that_a_tool_call_began_before_its_arguments_are_written(world):
    world.plans["muéstrame"] = TurnPlan(
        reply="", tool="show", tool_tokens=200, preamble="Te lo dibujo."
    )
    model = build_llm(Settings.from_env(ENV))
    told = []

    chunks = await written(
        model, "muéstrame las barras", lambda: told.append(len(world.model_calls[-1].events))
    )

    call = world.model_calls[-1]
    # Told once, on the event that begins the call: every one of its
    # arguments' events came after.
    (at,) = told
    assert call.events[at - 1] == "content_block_start" and call.tool_calls == ["show"]
    assert call.events[at:].count("content_block_delta") >= 60
    # The plugin hands the call over only once it is all written.
    assert [c.delta.tool_calls[0].name for c in chunks if c.delta and c.delta.tool_calls] == [
        "show"
    ]


async def test_a_reply_without_a_tool_tells_nothing_and_nothing_else_changes(world):
    world.plans["muéstrame"] = TurnPlan(reply="", tool="show", tool_tokens=40)
    model = build_llm(Settings.from_env(ENV))
    told = []

    reply = await written(model, "hola, ¿qué tal?", lambda: told.append("began"))
    tapped = await written(model, "muéstrame las barras", lambda: told.append("began"))
    plain = await written(model, "muéstrame las barras")

    assert reply and told == ["began"]
    # The events reach the plugin unchanged: it hands over the same chunks.
    assert kept(tapped) == kept(plain) and kept(tapped)[-1][1][0][0] == "show"
