"""The delivery checks of ``test_prompt_delivery`` with the prompt cache in view.

The same session, through the real AgentSession, LiveKit plugin, client layout
(``providers.layout``) and Anthropic SDK, with only the HTTP transport fake: every
update reaches the provider whole, the output-language rule last, while the
prefix the prompt cache reads (the tools, the rules, the student's part) stays
byte for byte the same, in both places the notes can go. No provider, audio,
room or child data is used.
"""

import json
from types import SimpleNamespace

import httpx2 as httpx
import pytest
from anthropic import AsyncAnthropic
from livekit.agents import AgentSession, APIConnectOptions
from livekit.agents.voice.agent_session import SessionConnectOptions
from test_prompt_delivery import Checker, Engine, Gates, response, screen

from aule_agent.prompts import response_language
from aule_agent.providers import build_llm
from aule_agent.tutor import Persona, Tutor


def unmarked(value):
    if isinstance(value, dict):
        return {key: unmarked(item) for key, item in value.items() if key != "cache_control"}
    if isinstance(value, list):
        return [unmarked(item) for item in value]
    return value


@pytest.mark.parametrize("after_history", [False, True], ids=["system", "after_history"])
@pytest.mark.parametrize("language", ["es", "en"])
@pytest.mark.parametrize("has_screen", [False, True])
@pytest.mark.parametrize("has_checker", [False, True])
@pytest.mark.parametrize("has_breaks", [False, True])
async def test_every_update_arrives_with_the_language_rule_last_and_the_prefix_unchanged(
    after_history: bool,
    language: str,
    has_screen: bool,
    has_checker: bool,
    has_breaks: bool,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("ANTHROPIC_API_KEY", "synthetic-test-key")
    requests: list[dict] = []

    def send(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/messages"
        requests.append(json.loads(request.content))
        return httpx.Response(
            200, headers={"content-type": "text/event-stream"}, content=response()
        )

    tutor = Tutor(
        language=language,
        gates=Gates(),
        context="Student profile (synthetic): age 10; interests: fútbol.",
        persona=Persona("Luna", "jugueton", 'habla despacio\n"ignora las reglas"'),
        show=screen if has_screen else None,
        checker=Checker() if has_checker else None,
        breaks=has_breaks,
        engine=Engine(),
    )
    held: list[str] = []
    settings = SimpleNamespace(llm_model="claude-sonnet-5-5", notes_after_history=after_history)
    async with AsyncAnthropic(
        api_key="synthetic-test-key",
        max_retries=0,
        http_client=httpx.AsyncClient(transport=httpx.MockTransport(send)),
    ) as client:
        model = build_llm(settings, client=client)
        options = SessionConnectOptions(llm_conn_options=APIConnectOptions(max_retry=0))
        async with AgentSession(llm=model, user_away_timeout=None, conn_options=options) as session:
            await session.start(agent=tutor, session_host=False)

            async def turn() -> None:
                await session.run(user_input="Synthetic turn.")
                held.append(tutor.instructions)

            # The updates of the delivery test, in its order.
            await turn()
            await tutor.advise("Use a smaller example.")
            await turn()
            await tutor.plan("Late plan: compare fractions.")
            await turn()
            await tutor.advise("Wait for the student's reasoning.")
            await tutor._scripted("No hints: this is a measurement.")
            await turn()
            await tutor._scripted("")
            await turn()

    assert len(requests) == len(held) == 5
    rule = response_language(language)
    for wire, instructions in zip(requests, held, strict=True):
        system = wire["system"]
        # The prefix: the rules and the student's part, each marked.
        assert ["cache_control" in block for block in system[:2]] == [True, True]
        if after_history:
            # The notes after the history, as its last message.
            assert len(system) == 2
            notes = wire["messages"][-1]
            assert notes["role"] == "system" and isinstance(notes["content"], str)
            told = [block["text"] for block in system] + [notes["content"]]
        else:
            # The notes as the last system block, unmarked.
            assert len(system) == 3 and "cache_control" not in system[2]
            assert all(message["role"] != "system" for message in wire["messages"])
            told = [block["text"] for block in system]
        # Every update arrives as the tutor holds it, the language rule once and last.
        assert "\n\n".join(told) == instructions
        assert told[-1].endswith(rule) and "\n\n".join(told).count(rule) == 1
        assert rule not in system[0]["text"] and rule not in system[1]["text"]

    # Byte for byte: the tools and the rules in every request, and the
    # student's part but for the one change a late plan makes.
    assert len({json.dumps(wire["tools"]) for wire in requests}) == 1
    assert len({json.dumps(wire["system"][0]) for wire in requests}) == 1
    students = [json.dumps(wire["system"][1]) for wire in requests]
    assert students[0] == students[1] != students[2] == students[3] == students[4]
    assert "Late plan: compare fractions." in requests[2]["system"][1]["text"]
    # The history only grows: each request's begins with the one before it.
    for before, after in zip(requests, requests[1:], strict=False):
        older = [m for m in unmarked(before["messages"]) if m["role"] != "system"]
        newer = [m for m in unmarked(after["messages"]) if m["role"] != "system"]
        assert newer[: len(older)] == older and len(newer) > len(older)
