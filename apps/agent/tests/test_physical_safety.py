"""The physical-safety gate with a fake transport: no network, no paid calls."""

import asyncio
import json

import aiohttp
import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer
from livekit.agents import llm

from aule_agent.moderation import Action, Decision, Probe
from aule_agent.physical_safety import (
    GRADE_AGES,
    MAX_BYTES,
    MAX_HISTORY_ITEMS,
    QUESTION,
    UNKNOWN_AGE,
    PhysicalSafetyGuard,
    Verdict,
    _StatusError,
    age_for,
    combine_input_decisions,
    parse_response,
)


def message(text="Hola", *, role="user"):
    return llm.ChatMessage(role=role, content=[text])


def response(probability=0.01):
    return {
        "model": "jev-1.14.0",
        "answers": {"needs_adult": {"type": "noul", "noul": probability}},
        "usage": {"input_tokens": 700},
    }


class Provider:
    """Stands in for the provider: records request bodies and answers from a script."""

    def __init__(self):
        self.requests = []
        self.payload = response()
        self.raw = None
        self.error = None
        self.delay = 0.0

    async def __call__(self, body):
        assert len(body) <= MAX_BYTES
        self.requests.append(json.loads(body))
        await asyncio.sleep(self.delay)
        if self.error is not None:
            raise self.error
        return self.raw if self.raw is not None else json.dumps(self.payload).encode()


@pytest.fixture
def provider():
    return Provider()


@pytest.fixture
async def guard(provider):
    instance = PhysicalSafetyGuard("synthetic-test-key", age=8, send=provider)
    yield instance
    await instance.close()


def empty():
    return llm.ChatContext.empty()


@pytest.mark.parametrize(
    ("risk", "verdict"),
    [
        (0, Verdict.ALLOW),
        (0.1, Verdict.ALLOW),
        (0.10001, Verdict.UNCERTAIN),
        (0.24999, Verdict.UNCERTAIN),
        (0.25, Verdict.ADULT_HELP),
        (1, Verdict.ADULT_HELP),
    ],
)
def test_probability_boundaries(risk, verdict):
    assert parse_response(json.dumps(response(risk)).encode()) is verdict


@pytest.mark.parametrize("risk", [True, None, "0.0", -0.1, 1.1, float("nan"), float("inf")])
def test_an_invalid_probability_never_allows(risk):
    with pytest.raises(ValueError):
        parse_response(json.dumps(response(risk)).encode())


@pytest.mark.parametrize("verdict", list(Verdict))
@pytest.mark.parametrize("action", list(Action))
def test_combining_never_weakens_what_moderation_decided(action, verdict):
    existing = Decision(action, None if action is Action.ALLOW else "original")

    combined = combine_input_decisions(existing, verdict)

    if action in (Action.SUPPORT, Action.UNAVAILABLE) or verdict is Verdict.ALLOW:
        assert combined == existing
    elif verdict is Verdict.ADULT_HELP:
        assert combined == Decision(Action.REDIRECT, "adult_help")
    elif verdict is Verdict.UNCERTAIN:
        assert combined == (
            existing if action is Action.REDIRECT else Decision(Action.REDIRECT, "clarify")
        )
    elif verdict is Verdict.CONTEXT_LIMIT:
        assert combined == Decision(Action.UNAVAILABLE, "context_limit")
    else:
        assert combined == Decision(Action.UNAVAILABLE, "unavailable")
    assert not (combined.allowed and (verdict is not Verdict.ALLOW or not existing.allowed))


async def test_a_closed_guard_answers_unavailable_without_calling(guard, provider):
    assert await guard.check(empty(), message()) is Verdict.ALLOW
    assert provider.requests[0]["model"] == "jev-1.14.0"

    await guard.close()

    assert await guard.check(empty(), message()) is Verdict.UNAVAILABLE
    assert len(provider.requests) == 1


@pytest.mark.parametrize(
    "error", [ValueError("unexpected status"), OSError("network"), RuntimeError("anything")]
)
async def test_a_failed_call_is_unavailable_and_not_retried(guard, provider, error):
    provider.error = error

    assert await guard.check(empty(), message()) is Verdict.UNAVAILABLE
    assert len(provider.requests) == 1


@pytest.mark.parametrize(
    "raw",
    [
        b"not json",
        b"null",
        b"[]",
        b'{"model":"other","answers":{}}',
        b'{"model":"jev-1.14.0","answers":{"needs_adult":{"type":"choice","noul":0}}}',
        b'{"model":"jev-1.14.0","answers":{"needs_adult":{"type":"noul","noul":0},"extra":{}}}',
        b"[" * 2000 + b"0" + b"]" * 2000,
    ],
)
async def test_a_malformed_answer_fails_closed(guard, provider, raw):
    provider.raw = raw

    assert await guard.check(empty(), message()) is Verdict.UNAVAILABLE


@pytest.mark.parametrize("model", ["jev-1.13.0", "jev-preview", "jev-latest", "other"])
async def test_an_answer_from_another_model_cannot_allow(guard, provider, model):
    provider.payload["model"] = model

    assert await guard.check(empty(), message()) is Verdict.UNAVAILABLE


async def test_no_answer_is_asked_once_more_and_then_is_unavailable(guard, provider, monkeypatch):
    monkeypatch.setattr("aule_agent.physical_safety.FIRST_TRY_SECONDS", 0.01)
    monkeypatch.setattr("aule_agent.physical_safety.SECOND_TRY_SECONDS", 0.01)
    provider.delay = 5

    assert await guard.check(empty(), message()) is Verdict.UNAVAILABLE
    assert len(provider.requests) == 2


async def test_a_second_try_that_answers_counts(guard, provider, monkeypatch):
    monkeypatch.setattr("aule_agent.physical_safety.FIRST_TRY_SECONDS", 0.01)
    provider.payload = response(0.99)
    provider.delay = 5

    async def slow_then_quick(body, calls=[]):  # noqa: B006
        calls.append(body)
        provider.delay = 5 if len(calls) == 1 else 0
        return await Provider.__call__(provider, body)

    guard._send = slow_then_quick

    assert await guard.check(empty(), message("Voy a meter un tenedor en el enchufe")) is (
        Verdict.ADULT_HELP
    )
    assert len(provider.requests) == 2


async def test_an_answer_that_is_refused_or_malformed_is_not_asked_again(guard, provider):
    provider.error = ValueError("unexpected status")

    assert await guard.check(empty(), message()) is Verdict.UNAVAILABLE
    assert len(provider.requests) == 1


async def test_only_recent_text_is_sent_and_the_conversation_is_left_alone(guard, provider):
    context = empty()
    context.add_message(role="system", content="Private system prompt")
    context.add_message(role="developer", content="Private developer prompt")
    context.items.append(
        llm.FunctionCall(id="tool", call_id="t", name="lookup", arguments="secret")
    )
    original = list(context.items)
    provider.payload = response(0.99)
    first = message("Tengo un cuchillo real en la mano")

    assert await guard.check(context, first) is Verdict.ADULT_HELP
    await guard.check(context, message("¿Se lo llevo?"))

    # The stopped turn never joined the conversation, yet the follow-up has it.
    sent = provider.requests[-1]
    assert sent["state"] == {
        "age": 8,
        "history": [{"role": "user", "content": "Tengo un cuchillo real en la mano"}],
        "utterance": "¿Se lo llevo?",
    }
    assert sent["questions"] == {"needs_adult": QUESTION}
    assert context.items == original
    assert "secret" not in json.dumps(sent)
    assert "Private" not in json.dumps(sent)


async def test_history_is_ordered_without_repeats_and_bounded(provider):
    guard = PhysicalSafetyGuard("test", age=True, send=provider)
    context = empty()
    previous = message("Ya viene mi mamá")
    assert await guard.check(context, previous) is Verdict.ALLOW
    context.items.append(previous)
    context.add_message(role="assistant", content="Pídele ayuda")

    assert await guard.check(context, message("Está aquí")) is Verdict.ALLOW

    sent = provider.requests[-1]
    assert sent["state"]["age"] == "unknown (child)"
    assert [item["content"] for item in sent["state"]["history"]] == [
        "Ya viene mi mamá",
        "Pídele ayuda",
    ]

    for number in range(100):
        context.add_message(role="user", content=str(number))
    assert await guard.check(context, message("Hola")) is Verdict.ALLOW
    assert len(provider.requests[-1]["state"]["history"]) == MAX_HISTORY_ITEMS


async def test_a_sentence_too_long_to_judge_is_never_sent_or_forgotten(guard, provider):
    assert await guard.check(empty(), message("ñ" * MAX_BYTES)) is Verdict.CONTEXT_LIMIT
    assert await guard.check(empty(), message("¿Lo hago?")) is Verdict.CONTEXT_LIMIT
    assert provider.requests == []


async def test_old_context_is_dropped_as_whole_messages(guard, provider):
    context = empty()
    for text in ("a" * 10000, "ñ" * 6000, "c" * 10000):
        context.add_message(role="user", content=text)
    original = list(context.items)

    assert await guard.check(context, message()) is Verdict.ALLOW

    history = provider.requests[-1]["state"]["history"]
    assert [item["content"] for item in history] == ["ñ" * 6000, "c" * 10000]
    assert context.items == original


async def test_a_long_conversation_does_not_block_later_short_turns(guard, provider):
    context = empty()
    context.add_message(role="user", content="a" * 11000)
    context.add_message(role="assistant", content="b" * 1000)
    current = message("c" * 10000)
    assert await guard.check(context, current) is Verdict.ALLOW
    context.items.append(current)
    context.add_message(role="assistant", content="d" * 1000)

    for _ in range(5):
        assert await guard.check(context, message("Hola")) is Verdict.ALLOW
        state = provider.requests[-1]["state"]
        assert state["utterance"] == "Hola"
        assert {item["content"] for item in state["history"]} >= {"c" * 10000, "d" * 1000}


@pytest.mark.parametrize(
    ("probability", "error", "verdict"),
    [
        (0.99, None, Verdict.ADULT_HELP),
        (0.2, None, Verdict.UNCERTAIN),
        (0.01, ValueError("unexpected status"), Verdict.UNAVAILABLE),
    ],
)
async def test_unresolved_context_outlives_the_history_window(
    guard, provider, probability, error, verdict
):
    context = empty()
    context.add_message(role="assistant", content="¿Qué tienes en la mano?")
    provider.payload, provider.error = response(probability), error
    assert await guard.check(context, message("Tengo un cuchillo real")) is verdict

    context = empty()  # the conversation may have been trimmed since
    for number in range(30):
        context.add_message(role="assistant", content=f"{number}:" + "x" * 1000)
    provider.payload, provider.error = response(0.01), None
    assert await guard.check(context, message("¿Se lo llevo?")) is Verdict.ALLOW

    contents = [item["content"] for item in provider.requests[-1]["state"]["history"]]
    assert contents[:2] == ["¿Qué tienes en la mano?", "Tengo un cuchillo real"]

    assert not guard._protected  # the "allow" resolved it


async def test_unresolved_context_that_no_longer_fits_stops_the_session(guard, provider):
    provider.payload = response(0.99)

    assert await guard.check(empty(), message("a" * 15000)) is Verdict.ADULT_HELP
    assert await guard.check(empty(), message("b" * 10000)) is Verdict.CONTEXT_LIMIT
    assert await guard.check(empty(), message("¿Lo hago?")) is Verdict.CONTEXT_LIMIT
    assert len(provider.requests) == 1


async def test_a_cancelled_check_propagates_and_keeps_its_context(guard, provider):
    provider.delay = 0.3
    task = asyncio.create_task(guard.check(empty(), message("Tengo un cable pelado")))
    while not provider.requests:
        await asyncio.sleep(0)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task

    provider.delay = 0
    await guard.check(empty(), message("¿Lo toco?"))

    assert provider.requests[-1]["state"]["history"] == [
        {"role": "user", "content": "Tengo un cable pelado"}
    ]


async def test_logs_carry_the_verdict_and_never_the_text_or_the_key(guard, provider, caplog):
    provider.payload = response(0.99)

    with caplog.at_level("DEBUG"):
        await guard.check(empty(), message("secret words of a child"))

    (record,) = caplog.records
    assert record.verdict == "adult_help"
    assert isinstance(record.duration_ms, int)
    logged = str(record.__dict__)
    assert "secret" not in logged and "synthetic-test-key" not in logged and "0.99" not in logged


@pytest.mark.parametrize(
    ("age", "grade", "told"),
    [
        (9, "P4", 9),
        (9, None, 9),
        (0, None, 0),
        (17, "S5", 17),
        (None, "P1", "6-7"),
        (None, "P3", "8-9"),
        (None, "S5", "16-17"),
        # An age that is not a child's is not passed on: the grade's ages are.
        (18, "S5", "16-17"),
        (-1, None, UNKNOWN_AGE),
        (True, "P3", "8-9"),
        ("9", None, UNKNOWN_AGE),
        (None, "p4", UNKNOWN_AGE),
        (None, "4 primaria", UNKNOWN_AGE),
        (None, None, UNKNOWN_AGE),
    ],
)
def test_the_age_is_the_platforms_or_the_grades_and_never_a_guess(age, grade, told):
    assert age_for(age, grade) == told


def test_every_school_grade_has_the_ages_of_its_year():
    assert list(GRADE_AGES) == [
        *(f"P{year}" for year in range(1, 7)),
        *(f"S{year}" for year in range(1, 6)),
    ]
    # A first grader is six or seven, and each grade is a year older than the one before.
    assert [band.split("-") for band in GRADE_AGES.values()] == [
        [str(age), str(age + 1)] for age in range(6, 17)
    ]


async def test_the_request_tells_how_old_the_student_is_and_nothing_else_about_them(provider):
    guard = PhysicalSafetyGuard("synthetic-test-key", send=provider)

    await guard.check(empty(), message())
    guard.for_student(None, "P3")
    await guard.check(empty(), message())
    guard.for_student(9, "P4")
    await guard.check(empty(), message())
    await guard.close()

    assert [sent["state"]["age"] for sent in provider.requests] == [UNKNOWN_AGE, "8-9", 9]
    assert all(set(sent["state"]) == {"age", "history", "utterance"} for sent in provider.requests)


def history(*lines):
    """A conversation in which (role, text) lines were said, in that order."""
    context = llm.ChatContext.empty()
    for role, text in lines:
        context.add_message(role=role, content=text)
    return context


async def test_the_tutors_lines_are_sent_without_the_students_name(provider):
    guard = PhysicalSafetyGuard("synthetic-test-key", send=provider)
    guard.for_student(9, "P4", "Liam")
    said = history(
        ("assistant", "¡Hola, Liam! Soy Aule, qué gusto verte. Cuéntame, ¿cómo te fue hoy?"),
        ("user", "Bien. Mi hermano me dice Liam el cocinero."),
        ("assistant", "¡Muy bien, Liam! ¿Qué cocinaron, LIAM?"),
    )

    await guard.check(said, message("¿Puedo prender la cocina yo solo?"))
    await guard.close()

    (sent,) = provider.requests
    assert sent["state"]["history"] == [
        {
            "role": "assistant",
            "content": "¡Hola, [student]! Soy Aule, qué gusto verte. Cuéntame, ¿cómo te fue hoy?",
        },
        # What the student says is judged as they said it.
        {"role": "user", "content": "Bien. Mi hermano me dice Liam el cocinero."},
        {"role": "assistant", "content": "¡Muy bien, [student]! ¿Qué cocinaron, [student]?"},
    ]
    assert sent["state"]["utterance"] == "¿Puedo prender la cocina yo solo?"


@pytest.mark.parametrize(
    ("name", "line", "sent"),
    [
        # The whole name and each of its words, and never inside another word.
        (
            "Ana Lucía",
            "Muy bien, Ana Lucía. Mañana abre la ventana, Ana.",
            "Muy bien, [student]. Mañana abre la ventana, [student].",
        ),
        # As the platform gave it, or with a capital first letter.
        (
            "ana",
            "Muy bien, ana. Mañana, Ana, abre la ventana.",
            "Muy bien, [student]. Mañana, [student], abre la ventana.",
        ),
        ("MATEO", "¡Hola, MATEO! Sigamos, Mateo.", "¡Hola, [student]! Sigamos, [student]."),
        # A name is text, not a pattern.
        ("J.P.", "Bien hecho, J.P. ¿Y JxPx?", "Bien hecho, [student] ¿Y JxPx?"),
        # A name that is also a word stays a word where it is written as one.
        ("Luz", "Apaga la luz, Luz.", "Apaga la luz, [student]."),
        # A single letter is no name to take out of a sentence.
        ("A. Bo", "A. Bo, la A. es tuya, Bo.", "[student], la A. es tuya, [student]."),
        (None, "¡Hola, Liam!", "¡Hola, Liam!"),
        ("  ", "¡Hola!", "¡Hola!"),
    ],
)
async def test_the_name_is_left_out_word_by_word_and_only_where_it_is_the_name(
    provider, name, line, sent
):
    guard = PhysicalSafetyGuard("synthetic-test-key", send=provider)
    guard.for_student(None, None, name)

    await guard.check(history(("assistant", line)), message())
    await guard.close()

    assert provider.requests[0]["state"]["history"][0]["content"] == sent


async def test_the_name_is_kept_out_of_the_context_the_gate_holds_on_to(provider):
    # A hazard keeps its context until a safe turn resolves it: what is sent
    # again later is still without the name.
    provider.payload = response(0.9)
    guard = PhysicalSafetyGuard("synthetic-test-key", send=provider)
    guard.for_student(9, None, "Liam")

    first = history(("assistant", "¡Hola, Liam!"))
    assert await guard.check(first, message("Tengo un cuchillo")) is Verdict.ADULT_HELP
    assert await guard.check(empty(), message("¿Puedo cortar?")) is Verdict.ADULT_HELP
    await guard.close()

    assert all("Liam" not in json.dumps(sent) for sent in provider.requests)
    assert {"role": "assistant", "content": "¡Hola, [student]!"} in (
        provider.requests[1]["state"]["history"]
    )


class Models:
    """Stands in for the provider's list of models."""

    def __init__(self, answer=None, delay=0.0):
        self.answer = answer
        self.delay = delay
        self.calls = 0

    async def __call__(self):
        self.calls += 1
        await asyncio.sleep(self.delay)
        if isinstance(self.answer, Exception):
            raise self.answer
        if isinstance(self.answer, bytes):
            return self.answer
        listed = {"name": "jev-latest", "description": "General", "release_date": "2026-09-15"}
        return json.dumps({"models": [listed]}).encode()


async def test_the_probe_lists_the_models_and_sends_nothing_of_the_conversation(provider):
    models = Models()
    guard = PhysicalSafetyGuard("synthetic-test-key", send=provider, list_models=models)

    assert await guard.probe() is Probe.ANSWERS
    assert models.calls == 1
    assert provider.requests == []
    await guard.close()


@pytest.mark.parametrize(
    ("answer", "probe"),
    [
        (_StatusError(401), Probe.KEY_REFUSED),
        (_StatusError(403), Probe.KEY_REFUSED),
        (_StatusError(429), Probe.UNEXPECTED),
        (_StatusError(500), Probe.UNEXPECTED),
        (aiohttp.ClientConnectionError(), Probe.UNREACHABLE),
        (OSError("name does not resolve"), Probe.UNREACHABLE),
        (TimeoutError(), Probe.UNREACHABLE),
        (ValueError("response too large"), Probe.UNEXPECTED),
        (b"not json", Probe.UNEXPECTED),
        (b"[]", Probe.UNEXPECTED),
        (b'{"models": []}', Probe.UNEXPECTED),
        (b'{"models": "jev-latest"}', Probe.UNEXPECTED),
        (b'{"models": [{"id": "jev-latest"}]}', Probe.UNEXPECTED),
        (b"[" * 2000 + b"0" + b"]" * 2000, Probe.UNEXPECTED),
    ],
)
async def test_a_probe_without_a_usable_answer_says_why(answer, probe):
    guard = PhysicalSafetyGuard("synthetic-test-key", list_models=Models(answer))

    assert await guard.probe() is probe
    await guard.close()


async def test_a_probe_with_no_answer_in_time_is_unreachable(monkeypatch):
    monkeypatch.setattr("aule_agent.physical_safety.PROBE_SECONDS", 0.01)
    guard = PhysicalSafetyGuard("synthetic-test-key", list_models=Models(delay=5))

    assert await guard.probe() is Probe.UNREACHABLE
    await guard.close()


async def test_a_closed_guard_is_not_probed():
    models = Models()
    guard = PhysicalSafetyGuard("synthetic-test-key", list_models=models)
    await guard.close()

    assert await guard.probe() is Probe.UNREACHABLE
    assert models.calls == 0


async def test_the_probe_logs_what_happened_and_never_the_key(caplog):
    guard = PhysicalSafetyGuard("synthetic-test-key", list_models=Models(_StatusError(401)))

    with caplog.at_level("DEBUG"):
        await guard.probe()

    (record,) = caplog.records
    assert (record.levelname, record.probe, record.status) == ("WARNING", "key_refused", 401)
    assert isinstance(record.duration_ms, int)
    assert "synthetic-test-key" not in str(record.__dict__)


async def test_the_probe_and_the_turns_reach_the_provider_as_written(monkeypatch):
    """Against a stand-in for the provider on this machine, with the real HTTP code."""
    seen = []

    async def models(request):
        seen.append((request.method, request.path, await request.read(), request.transport))
        if request.headers.get("Authorization") != "Bearer synthetic-test-key":
            return web.json_response({"detail": "invalid key"}, status=401)
        listed = {"name": "jev-latest", "description": "General", "release_date": "2026-09-15"}
        return web.json_response({"models": [listed]})

    async def systemone(request):
        seen.append((request.method, request.path, await request.read(), request.transport))
        return web.json_response(response(0.01))

    app = web.Application()
    app.router.add_get("/v1/models", models)
    app.router.add_post("/v1/systemone", systemone)
    async with TestServer(app) as server:
        monkeypatch.setattr(
            "aule_agent.physical_safety.MODELS_ENDPOINT", str(server.make_url("/v1/models"))
        )
        monkeypatch.setattr(
            "aule_agent.physical_safety.ENDPOINT", str(server.make_url("/v1/systemone"))
        )
        guard = PhysicalSafetyGuard("synthetic-test-key", age=9)
        refused = PhysicalSafetyGuard("another-key")
        assert await guard.probe() is Probe.ANSWERS
        assert await guard.check(empty(), message("¿Me ayudas con las fracciones?")) is (
            Verdict.ALLOW
        )
        assert await refused.probe() is Probe.KEY_REFUSED
        await guard.close()
        await refused.close()

    (probe, check, other) = seen
    assert (probe[0], probe[1], probe[2]) == ("GET", "/v1/models", b"")
    assert (check[0], check[1]) == ("POST", "/v1/systemone")
    assert json.loads(check[2])["state"]["age"] == 9
    # The turn went out on the connection the probe opened.
    assert check[3] is probe[3]
    assert other[3] is not probe[3]
