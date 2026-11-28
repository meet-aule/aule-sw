import asyncio
import json

import pytest
from aiohttp import web
from aiohttp.test_utils import TestServer

from aule_agent._version import __version__
from aule_agent.homework import Course, Reading
from aule_agent.platform import (
    FLAG_COOLDOWN_SECONDS,
    HOMEWORK_TIMEOUT_SECONDS,
    MAX_FLAGS_IN_FLIGHT,
    MAX_PENDING_TURNS,
    Platform,
    PlatformSession,
    Refused,
    platform_session,
    user_agent,
)
from aule_agent.script import Line, Reply
from aule_agent.tutor import OpenExercise

SESSION = PlatformSession(url="http://platform", token="t")
ENV = {"AULE_PLATFORM_URL": "http://platform/"}


class Recorder:
    """Stands in for the platform: records calls and answers from a script."""

    def __init__(self, *answers):
        self.calls = []
        self.timeouts = []
        self.answers = list(answers)

    async def __call__(self, method, path, body, timeout):
        self.calls.append((method, path, body))
        self.timeouts.append(timeout)
        answer = self.answers.pop(0) if self.answers else {}
        if isinstance(answer, Exception):
            raise answer
        return answer


def test_a_job_belongs_to_a_platform_session_only_with_a_url_and_a_token():
    metadata = json.dumps({"audience": "operator", "platform_token": "abc"})

    assert platform_session(metadata, ENV) == PlatformSession(url="http://platform", token="abc")
    assert platform_session(metadata, {}) is None
    assert platform_session('{"audience": "operator"}', ENV) is None
    assert platform_session('{"platform_token": 7}', ENV) is None
    assert platform_session("not json", ENV) is None


async def test_every_call_says_which_build_of_the_agent_makes_it(monkeypatch):
    monkeypatch.setenv("AULE_COMMIT", "0123456789ab")
    heard = []

    async def answer(request):
        heard.append((request.path, request.headers.get("User-Agent")))
        return web.json_response({"instructions": "Plan"})

    app = web.Application()
    app.router.add_route("*", "/{path:.*}", answer)
    async with TestServer(app) as server:
        platform = Platform(PlatformSession(url=str(server.make_url("")).rstrip("/"), token="t"))
        assert await platform.start() == "Plan"
        await platform.end()

    named = f"aule-agent/{__version__} (+0123456)"
    assert heard == [("/v1/agent/session", named), ("/v1/agent/session/end", named)]
    assert user_agent("unknown") == f"aule-agent/{__version__} (+unknown)"


async def test_start_returns_the_instructions_or_nothing(monkeypatch):
    monkeypatch.setattr("aule_agent.platform.START_RETRY_SECONDS", 0)
    assert await Platform(SESSION, Recorder({"instructions": "Plan"})).start() == "Plan"
    assert await Platform(SESSION, Recorder({})).start() == ""
    assert await Platform(SESSION, Recorder(RuntimeError("down"))).start() == ""


async def test_start_tries_once_more_when_the_platform_is_restarting(monkeypatch):
    monkeypatch.setattr("aule_agent.platform.START_RETRY_SECONDS", 0)
    send = Recorder(RuntimeError("down"), {"instructions": "Plan"})

    assert await Platform(SESSION, send).start() == "Plan"
    assert len(send.calls) == 2


async def test_an_exercise_is_posed_and_its_answer_judged_by_the_platform():
    send = Recorder(
        {"exercise": 1, "stage": "practice", "say": "Ask it and wait."},
        {"verdict": "incorrect", "say": "Give one hint.", "reveal": None},
        {"verdict": "incorrect", "closed": True, "say": "Work it out together.", "reveal": "7/8"},
    )
    platform = Platform(SESSION, send)

    assert await platform.pose("3/4 + 1/8", "fracciones.sumar", None) == "Ask it and wait."
    assert await platform.answer("cuatro doceavos") == "Give one hint."
    assert await platform.answer("no sé") == "Work it out together. The answer is 7/8."
    assert send.calls == [
        (
            "POST",
            "/v1/agent/session/exercises",
            {"expression": "3/4 + 1/8", "skill_id": "fracciones.sumar"},
        ),
        ("POST", "/v1/agent/session/answers", {"said": "cuatro doceavos"}),
        ("POST", "/v1/agent/session/answers", {"said": "no sé"}),
    ]


async def test_an_exercise_the_platform_cannot_check_is_not_an_error():
    platform = Platform(SESSION, Recorder(RuntimeError("platform answered 400"), RuntimeError()))

    assert await platform.pose("¿cuál es mayor?", None, None) is None
    assert await platform.answer("la roja") is None


SAME = {"exercise": 7, "stage": "practice", "say": "Same exercise as before: carry on with it."}


async def test_the_exercise_open_is_the_one_the_platform_last_opened():
    send = Recorder(
        {"exercise": 7, "stage": "practice", "say": "Ask it and wait."},
        SAME,
        {"exercise": 8, "stage": "practice", "say": "Ask it and wait."},
    )
    platform = Platform(SESSION, send)
    assert platform.exercise is None

    await platform.pose(" 25 + 3 * 2 ", None, None)
    assert platform.exercise == OpenExercise(id=7, expression="25 + 3 * 2")
    # Stated again, however it is written, it is the same exercise.
    await platform.pose("25+3×2", None, None)
    assert platform.exercise == OpenExercise(id=7, expression="25 + 3 * 2")
    await platform.pose("1/2 + 1/3", None, None)
    assert platform.exercise == OpenExercise(id=8, expression="1/2 + 1/3")


@pytest.mark.parametrize(
    "answer",
    [
        {"verdict": "correct", "closed": True, "say": "Correct."},
        {"verdict": "incorrect", "closed": True, "say": "Work it out.", "reveal": "31"},
        Refused(409),
    ],
)
async def test_an_answer_that_closes_the_exercise_or_finds_none_open_leaves_none_open(answer):
    platform = Platform(SESSION, Recorder({"exercise": 7, "say": "Ask it."}, answer))
    await platform.pose("25 + 3 * 2", None, None)

    await platform.answer("31")

    assert platform.exercise is None
    assert not platform.gone


@pytest.mark.parametrize(
    "answer",
    [
        {"verdict": "incorrect", "closed": False, "say": "Give one hint."},
        {"verdict": "dont_know", "say": "Give one hint."},
        TimeoutError(),
        RuntimeError("down"),
        Refused(400),
        Refused(500),
    ],
)
async def test_an_answer_that_leaves_it_open_or_fails_keeps_the_exercise(answer):
    platform = Platform(SESSION, Recorder({"exercise": 7, "say": "Ask it."}, answer))
    await platform.pose("25 + 3 * 2", None, None)

    await platform.answer("56")

    assert platform.exercise == OpenExercise(id=7, expression="25 + 3 * 2")


WORKED = {
    "verdict": "incorrect",
    "closed": False,
    "next": "worked_example",
    "say": "Work a similar one with other numbers, step by step. Then they retry theirs.",
}


async def test_an_answer_that_asks_for_a_worked_example_sets_the_exercise_aside_until_posed_again():
    send = Recorder({"exercise": 7, "say": "Ask it."}, WORKED, Refused(400), SAME)
    platform = Platform(SESSION, send)
    await platform.pose("25 + 3 * 2", None, None)

    assert await platform.answer("56") == WORKED["say"]
    # Still open, while the tutor works another example first.
    assert platform.exercise == OpenExercise(id=7, expression="25 + 3 * 2", aside=True)
    # A pose of something else that fails changes nothing.
    await platform.pose("¿cuál es mayor?", None, None)
    assert platform.exercise == OpenExercise(id=7, expression="25 + 3 * 2", aside=True)
    # Stated again, however it is written: the tutor is back on it.
    await platform.pose("25+3×2", None, None)
    assert platform.exercise == OpenExercise(id=7, expression="25 + 3 * 2")


@pytest.mark.parametrize(
    ("then", "after"),
    [
        # A new exercise posed: open, and the tutor on it.
        ({"exercise": 8, "say": "Ask it and wait."}, OpenExercise(id=8, expression="1/2 + 1/3")),
        # Closed by the answer after the worked example.
        ({"verdict": "incorrect", "closed": True, "say": "Work it out.", "reveal": "31"}, None),
    ],
)
async def test_an_exercise_set_aside_gives_way_to_a_new_one_or_closes(then, after):
    send = Recorder({"exercise": 7, "say": "Ask it."}, WORKED, then)
    platform = Platform(SESSION, send)
    await platform.pose("25 + 3 * 2", None, None)
    await platform.answer("56")

    if "exercise" in then:
        await platform.pose("1/2 + 1/3", None, None)
    else:
        await platform.answer("31")

    assert platform.exercise == after


@pytest.mark.parametrize("failure", [Refused(400), Refused(409), TimeoutError(), RuntimeError()])
async def test_a_pose_that_fails_keeps_the_exercise_open_before_it(failure):
    platform = Platform(SESSION, Recorder({"exercise": 7, "say": "Ask it."}, failure, {"say": "?"}))
    await platform.pose("25 + 3 * 2", None, None)

    # Not arithmetic it can check: the platform leaves the open one as it was.
    assert await platform.pose("¿cuál es mayor?", None, None) is None
    # An answer without an id says nothing about which exercise is open.
    await platform.pose("3 x 4", None, None)

    assert platform.exercise == OpenExercise(id=7, expression="25 + 3 * 2")


async def test_nothing_about_an_exercise_is_sent_once_the_platform_is_gone():
    send = Recorder({"exercise": 7, "say": "Ask it."}, Refused(410))
    platform = Platform(SESSION, send)
    await platform.pose("25 + 3 * 2", None, None)
    await platform.report_once()
    assert platform.gone

    assert await platform.pose("1/2 + 1/3", None, None) is None
    assert await platform.answer("31") is None

    assert [path for _, path, _ in send.calls] == [
        "/v1/agent/session/exercises",
        "/v1/agent/session/turns",
    ]


async def test_turns_are_numbered_and_named_for_the_platform():
    send = Recorder({"guidance": []})
    platform = Platform(SESSION, send)
    platform.heard("assistant", " ¿Cuánto es? ")
    platform.heard("user", "No sé")
    platform.heard("system", "ignored")
    platform.heard("user", "   ")

    assert await platform.report_once() is None

    assert send.calls == [
        (
            "POST",
            "/v1/agent/session/turns",
            {
                "turns": [
                    {"seq": 0, "role": "tutor", "content": "¿Cuánto es?"},
                    {"seq": 1, "role": "child", "content": "No sé"},
                ],
                "after_guidance": 0,
                "breaks_taken": 0,
            },
        )
    ]


async def test_the_newest_guidance_is_returned_and_not_asked_for_again():
    send = Recorder(
        {"guidance": [{"id": 3, "instructions": "old"}, {"id": 4, "instructions": "new"}]},
        {"guidance": []},
    )
    platform = Platform(SESSION, send)
    platform.heard("user", "a")

    assert await platform.report_once() == "new"
    platform.heard("user", "b")
    assert await platform.report_once() is None
    assert send.calls[1][2]["after_guidance"] == 4


async def test_turns_survive_a_failed_report_up_to_a_limit():
    send = Recorder(RuntimeError("down"), {"guidance": []})
    platform = Platform(SESSION, send)
    platform.heard("user", "first")

    assert await platform.report_once() is None
    platform.heard("assistant", "second")
    await platform.report_once()

    assert [turn["content"] for turn in send.calls[1][2]["turns"]] == ["first", "second"]

    for n in range(MAX_PENDING_TURNS + 10):
        platform.heard("user", str(n))
    await platform.report_once()
    batches = [body["turns"] for _, _, body in send.calls[2:]]
    assert all(len(batch) <= 20 for batch in batches)
    assert sum(len(batch) for batch in batches) == MAX_PENDING_TURNS


async def test_ending_sends_what_is_left_and_then_closes_the_session():
    send = Recorder({"guidance": []}, {})
    platform = Platform(SESSION, send)
    platform.heard("user", "bye")

    await platform.end()

    assert [call[1] for call in send.calls] == ["/v1/agent/session/turns", "/v1/agent/session/end"]


async def test_backlogged_turns_fit_the_api_limit_before_ending():
    send = Recorder()
    platform = Platform(SESSION, send)
    for n in range(45):
        platform.heard("user", str(n))

    await platform.end()

    batches = [body["turns"] for _, path, body in send.calls if path.endswith("/turns")]
    assert [len(batch) for batch in batches] == [20, 20, 5]
    assert [turn["seq"] for batch in batches for turn in batch] == list(range(45))
    assert send.calls[-1][1] == "/v1/agent/session/end"


async def test_a_failed_report_is_retried_without_waiting_for_another_turn(monkeypatch):
    monkeypatch.setattr("aule_agent.platform.REPORT_RETRY_SECONDS", 0.01, raising=False)
    delivered = asyncio.Event()
    calls = []

    async def send(method, path, body, timeout):
        calls.append(body)
        if len(calls) == 1:
            raise RuntimeError("temporary outage")
        delivered.set()
        return {}

    async def advise(_):
        pass

    platform = Platform(SESSION, send)
    platform.heard("user", "retry this turn")
    worker = asyncio.create_task(platform.run(advise))
    try:
        await asyncio.wait_for(delivered.wait(), timeout=0.5)
        assert calls[1]["turns"] == calls[0]["turns"]
    finally:
        worker.cancel()
        await asyncio.gather(worker, return_exceptions=True)


async def test_cancelling_an_inflight_report_keeps_its_turn_for_shutdown():
    started = asyncio.Event()
    calls = []

    async def send(method, path, body, timeout):
        calls.append((path, body))
        if len(calls) == 1:
            started.set()
            await asyncio.Event().wait()
        return {}

    platform = Platform(SESSION, send)
    platform.heard("user", "last turn")
    reporting = asyncio.create_task(platform.report_once())
    await started.wait()
    reporting.cancel()
    await asyncio.gather(reporting, return_exceptions=True)
    await platform.end()

    assert [path for path, _ in calls] == [
        "/v1/agent/session/turns",
        "/v1/agent/session/turns",
        "/v1/agent/session/end",
    ]
    assert calls[1][1]["turns"] == calls[0][1]["turns"]


async def test_shutdown_retries_a_failed_flush_before_ending(monkeypatch):
    monkeypatch.setattr("aule_agent.platform.REPORT_RETRY_SECONDS", 0.01)
    send = Recorder(RuntimeError("temporary outage"), {}, {})
    platform = Platform(SESSION, send)
    platform.heard("user", "last turn")

    await platform.end()

    assert [call[1] for call in send.calls] == [
        "/v1/agent/session/turns",
        "/v1/agent/session/turns",
        "/v1/agent/session/end",
    ]
    assert send.calls[-1][2] == {}


async def test_shutdown_bounds_an_outage_and_reports_the_loss(monkeypatch, caplog):
    monkeypatch.setattr("aule_agent.platform.REPORT_RETRY_SECONDS", 0.01)
    monkeypatch.setattr("aule_agent.platform.END_FLUSH_TIMEOUT_SECONDS", 0.03)
    calls = []

    async def send(method, path, body, timeout):
        calls.append((path, body))
        if path.endswith("/turns"):
            raise RuntimeError("outage")
        return {}

    platform = Platform(SESSION, send)
    platform.heard("user", "private text that must not be logged")
    await asyncio.wait_for(platform.end(), timeout=0.5)

    assert calls[-1] == ("/v1/agent/session/end", {"end_reason": "error"})
    assert "session ended with unreported turns" in caplog.text
    assert "private text" not in caplog.text


FLAGS = "/v1/agent/session/flags"


async def settle(platform):
    await asyncio.gather(*platform._flags)


async def test_a_flag_is_posted_in_the_background_with_fixed_vocabulary_only():
    release = asyncio.Event()
    calls = []

    async def send(method, path, body, timeout):
        calls.append((method, path, body))
        await release.wait()
        return {}

    platform = Platform(SESSION, send)

    platform.flag("physical_safety", "adult_help", ["physical_hazard", "violence"])  # no await

    await asyncio.sleep(0)
    assert calls == [
        (
            "POST",
            FLAGS,
            {
                "gate": "physical_safety",
                "action": "adult_help",
                "categories": ["physical_hazard", "violence"],
            },
        )
    ]
    release.set()
    await settle(platform)


async def test_a_flag_outside_the_vocabulary_is_dropped_without_raising():
    send = Recorder()
    platform = Platform(SESSION, send)

    platform.flag("moderation_input", "redirect", ["what the child said"])
    platform.flag("moderation_input", "redirect", [])
    platform.flag("moderation_input", "scold", ["violence"])
    platform.flag("abuse_limit", "redirect", ["violence"])
    platform.flag("the microphone", "redirect", ["violence"])

    assert platform._flags == set()
    assert send.calls == []


async def test_one_topic_is_flagged_once_per_cooldown():
    now = [1000.0]
    send = Recorder()
    platform = Platform(SESSION, send, clock=lambda: now[0])

    def flag(gate="moderation_input", action="redirect", categories=("violence",)):
        platform.flag(gate, action, list(categories))

    flag()
    flag()
    flag(categories=("violence", "hate"))  # the same gravest category
    await settle(platform)
    assert len(send.calls) == 1

    # Another category, action or gate is another topic: a quiet flag never
    # hides a grave one.
    flag(categories=("self_harm", "violence"), action="support")
    flag(gate="moderation_output")
    flag(gate="physical_safety", action="clarify", categories=("physical_hazard",))
    flag(gate="physical_safety", action="adult_help", categories=("physical_hazard",))
    await settle(platform)
    assert len(send.calls) == 5

    now[0] += FLAG_COOLDOWN_SECONDS - 1
    flag()
    await settle(platform)
    assert len(send.calls) == 5

    now[0] += 1
    flag()
    await settle(platform)
    assert len(send.calls) == 6


async def test_a_flag_that_did_not_arrive_does_not_use_up_the_cooldown():
    send = Recorder(RuntimeError("down"), {})
    platform = Platform(SESSION, send)

    platform.flag("moderation_input", "support", ["self_harm"])
    await settle(platform)
    platform.flag("moderation_input", "support", ["self_harm"])
    await settle(platform)

    assert [call[1] for call in send.calls] == [FLAGS, FLAGS]


async def test_flags_in_flight_are_bounded_and_the_end_does_not_wait_for_them(monkeypatch):
    monkeypatch.setattr("aule_agent.platform.FLAG_TIMEOUT_SECONDS", 0.01)
    calls = []

    async def send(method, path, body, timeout):
        calls.append(path)
        if path == FLAGS:
            await asyncio.Event().wait()
        return {}

    platform = Platform(SESSION, send)
    categories = ["self_harm", "sexual", "violence", "harassment", "hate", "illicit"]
    for category in categories:
        platform.flag("moderation_input", "redirect", [category])
    await asyncio.sleep(0)
    assert calls == [FLAGS] * MAX_FLAGS_IN_FLIGHT

    await platform.end()

    assert calls[-1] == "/v1/agent/session/end"
    assert all(task.cancelled() for task in platform._flags)


async def test_a_plan_that_arrives_late_reaches_the_tutor_once_and_before_guidance():
    send = Recorder(
        {"plan": "Plan: fractions.", "guidance": [{"id": 1, "instructions": "Slow down."}]},
        {"plan": "Plan: fractions.", "guidance": []},
    )
    platform = Platform(SESSION, send)
    told: list[tuple[str, str]] = []

    async def advise(text):
        told.append(("guidance", text))

    async def plan(text):
        told.append(("plan", text))

    worker = asyncio.create_task(platform.run(advise, plan))
    platform.heard("user", "hola")
    await asyncio.sleep(0.01)
    platform.heard("user", "otra vez")
    await asyncio.sleep(0.01)
    worker.cancel()
    await asyncio.gather(worker, return_exceptions=True)

    assert told == [("plan", "Plan: fractions."), ("guidance", "Slow down.")]


async def test_a_warning_and_then_the_end_are_each_asked_of_the_tutor_once():
    send = Recorder({"stop": "warn"}, {"stop": "warn"}, {"stop": "end"}, {"stop": None}, {})
    platform = Platform(SESSION, send)
    asked: list[str] = []

    async def advise(_):
        pass

    async def stop(kind):
        asked.append(kind)

    worker = asyncio.create_task(platform.run(advise, None, stop))
    for turn in range(5):
        platform.heard("user", f"jaja {turn}")
        await asyncio.sleep(0.01)
    worker.cancel()
    await asyncio.gather(worker, return_exceptions=True)

    # The end stands even when the platform stops repeating it.
    assert asked == ["warn", "end"]


async def test_a_session_stopped_for_not_working_ends_saying_so():
    send = Recorder()
    platform = Platform(SESSION, send)
    platform.end_reason = "not_working"

    await platform.end()

    assert send.calls[-1] == ("POST", "/v1/agent/session/end", {"end_reason": "not_working"})


async def test_the_name_and_the_number_of_the_session_are_read_for_the_greeting():
    platform = Platform(SESSION, Recorder({"student_name": " Liam ", "session_number": 7}))
    odd = Platform(SESSION, Recorder({"student_name": "x" * 41, "session_number": True}))

    await platform.start()
    await odd.start()

    assert (platform.student_name, platform.session_number) == ("Liam", 7)
    assert (odd.student_name, odd.session_number) == (None, None)


async def test_how_old_the_student_is_is_read_for_the_physical_safety_gate():
    platform = Platform(SESSION, Recorder({"student_age": 9, "student_grade": "P4"}))
    odd = Platform(SESSION, Recorder({"student_age": True, "student_grade": 4}))
    unknown = Platform(SESSION, Recorder({"student_age": None, "student_grade": None}))

    for each in (platform, odd, unknown):
        await each.start()

    assert (platform.student_age, platform.student_grade) == (9, "P4")
    assert (odd.student_age, odd.student_grade) == (None, None)
    assert (unknown.student_age, unknown.student_grade) == (None, None)


async def test_a_session_run_by_the_engine_opens_with_its_lines_and_asks_it_each_turn():
    send = Recorder(
        {"instructions": "Liam.", "script": {"lines": [{"say": "¡Hola, Liam!"}]}},
        {"lines": [{"say": "¿Cuántos sextos caben en un tercio?"}]},
        RuntimeError("platform answered 409"),
    )
    platform = Platform(SESSION, send)

    await platform.start()

    assert platform.scripted and [line.say for line in platform.opening().lines] == ["¡Hola, Liam!"]
    reply = await platform.said("cinco sextos")
    assert reply is not None and reply.lines[0].say == "¿Cuántos sextos caben en un tercio?"
    assert send.calls[-1] == ("POST", "/v1/agent/session/said", {"said": "cinco sextos"})
    # No answer from the engine is not an error: the model takes the turn.
    assert await platform.said("otra cosa") is None


async def test_only_a_board_worker_requests_the_engines_board_policy():
    send = Recorder({"lines": [], "converse": "Stay with the task.", "board_help": "identify"})
    platform = Platform(SESSION, send, progressive_board=True)
    reply = await platform.said("¿Por qué esta?")
    assert reply and reply.board_help == "identify"
    assert send.calls[-1] == (
        "POST",
        "/v1/agent/session/said",
        {"said": "¿Por qué esta?", "board": True},
    )


async def test_a_session_without_an_engine_is_not_scripted(monkeypatch):
    monkeypatch.setattr("aule_agent.platform.START_RETRY_SECONDS", 0)
    platform = Platform(SESSION, Recorder({"instructions": "Liam."}))

    await platform.start()

    assert not platform.scripted and platform.opening() == Reply()


@pytest.mark.parametrize("status", [401, 403, 409, 410])
async def test_a_start_the_platform_refuses_is_not_tried_again_and_the_session_is_gone(status):
    send = Recorder(Refused(status), {"instructions": "Plan"})
    platform = Platform(SESSION, send)

    assert await platform.start() == ""

    assert platform.gone
    assert len(send.calls) == 1


@pytest.mark.parametrize("failure", [RuntimeError("down"), Refused(500), Refused(404)])
async def test_a_platform_that_cannot_be_reached_is_not_a_refusal(monkeypatch, failure):
    monkeypatch.setattr("aule_agent.platform.START_RETRY_SECONDS", 0)
    send = Recorder(failure, {"instructions": "Plan"})
    platform = Platform(SESSION, send)

    # Tried once more, and the tutor works with what came back.
    assert await platform.start() == "Plan"
    assert not platform.gone


async def test_a_refused_report_ends_the_reports_instead_of_retrying_them(monkeypatch):
    monkeypatch.setattr("aule_agent.platform.REPORT_RETRY_SECONDS", 0.01)
    send = Recorder(Refused(409))
    platform = Platform(SESSION, send)
    told = []

    async def gone():
        told.append("gone")

    async def nothing(_):
        return None

    platform.heard("user", "hola")
    await asyncio.wait_for(platform.run(nothing, gone=gone), timeout=1)
    # What is said afterwards is not kept for a platform that will not take it.
    platform.heard("user", "¿sigues ahí?")
    await platform.end()

    assert platform.gone and told == ["gone"]
    assert [path for _, path, _ in send.calls] == ["/v1/agent/session/turns"]


async def test_a_refusal_about_one_exercise_is_not_about_the_session():
    send = Recorder(Refused(409), Refused(409), Refused(409), {})
    platform = Platform(SESSION, send)

    # The engine owns the exercises of its sessions and refuses the tutor's own.
    assert await platform.pose("3/4 + 1/8", None, None) is None
    assert await platform.answer("siete octavos") is None
    assert await platform.said("siete octavos") is None

    assert not platform.gone
    platform.heard("user", "hola")
    await platform.report_once()
    assert send.calls[-1][1] == "/v1/agent/session/turns"


async def test_a_break_is_handed_over_each_time_the_platform_offers_one():
    send = Recorder({"pause": "offer"}, {"pause": "offer"}, {"pause": None})
    platform = Platform(SESSION, send)
    offers = []

    async def pause():
        offers.append(len(send.calls))
        # The tutor proposed it: the next report says so.
        platform.breaks_taken = 1

    async def nothing(_):
        return None

    running = asyncio.create_task(platform.run(nothing, pause=pause))
    for text in ("uno", "dos", "tres"):
        platform.heard("user", text)
        for _ in range(10):
            await asyncio.sleep(0)
    running.cancel()
    await asyncio.gather(running, return_exceptions=True)

    # Offered twice and withdrawn once; the count travels with every report.
    assert offers == [1, 2]
    assert [body["breaks_taken"] for _, _, body in send.calls] == [0, 1, 1]


async def test_the_end_carries_the_numbers_of_the_session():
    send = Recorder()
    platform = Platform(SESSION, send)
    platform.end_reason = "not_working"

    await platform.end({"minutes": 31.5, "breaks_taken": 1, "llm_calls": 40})

    assert send.calls == [
        (
            "POST",
            "/v1/agent/session/end",
            {
                "end_reason": "not_working",
                "metrics": {"minutes": 31.5, "breaks_taken": 1, "llm_calls": 40},
            },
        )
    ]


async def test_what_the_engine_wrote_for_a_typed_answer_is_handed_over_once_and_in_order():
    send = Recorder(
        {"script": {"lines": [{"say": "¡Correcto!", "echoes": False}], "closed": False}},
        {"script": None},
        {"script": {"lines": [], "closed": True}},
    )
    platform = Platform(SESSION, send)
    handed = []

    async def written(lines):
        handed.append(lines)

    async def nothing(_):
        return None

    running = asyncio.create_task(platform.run(nothing, written=written))
    for _ in range(3):
        # The page says an answer went in: the report is made with no turn to send.
        platform.wake()
        for _ in range(10):
            await asyncio.sleep(0)
    running.cancel()
    await asyncio.gather(running, return_exceptions=True)

    assert [body["turns"] for _, _, body in send.calls] == [[], [], []]
    assert [(len(reply.lines), reply.closed) for reply in handed] == [(1, False), (0, True)]


async def test_an_engine_session_with_nothing_to_open_with_is_still_the_engines():
    platform = Platform(SESSION, Recorder({"instructions": "", "script": {"lines": []}}))

    await platform.start()

    assert platform.scripted and platform.opening() == Reply()


async def test_the_start_keeps_the_course_a_homework_photo_is_read_against():
    sent = {
        "topic": "Fracciones",
        "levels": [{"level": 1, "about": "Leer fracciones"}, {"level": 2, "about": "Comparar"}],
    }
    told = Platform(SESSION, Recorder({"instructions": "Plan", "homework": sent}))
    untold = Platform(SESSION, Recorder({"instructions": "Plan"}))
    odd = Platform(SESSION, Recorder({"instructions": "Plan", "homework": {"topic": "Fracciones"}}))

    for platform in (told, untold, odd):
        assert await platform.start() == "Plan"

    assert told.homework_course == Course("Fracciones", ("Leer fracciones", "Comparar"))
    # None sent, or not exactly a course: no photo is read in the session.
    assert untold.homework_course is None and odd.homework_course is None


async def test_the_start_says_that_the_agent_reads_homework_photos_only_when_it_does():
    reads, plain = Recorder({"instructions": "Plan"}), Recorder({"instructions": "Plan"})

    assert await Platform(SESSION, reads, homework_capability=1).start() == "Plan"
    assert await Platform(SESSION, plain).start() == "Plan"

    assert reads.calls == [("GET", "/v1/agent/session?homework=1", None)]
    assert plain.calls == [("GET", "/v1/agent/session", None)]


async def test_the_homework_question_reaches_the_platform_as_a_query():
    heard = []

    async def answer(request):
        heard.append((request.path, dict(request.query)))
        return web.json_response({"instructions": "Plan"})

    app = web.Application()
    app.router.add_route("*", "/{path:.*}", answer)
    async with TestServer(app) as server:
        url = str(server.make_url("")).rstrip("/")
        platform = Platform(PlatformSession(url=url, token="t"), homework_capability=1)
        assert await platform.start() == "Plan"
        await platform.end()

    assert heard[0] == ("/v1/agent/session", {"homework": "1"})


async def test_the_engines_opening_says_what_it_waits_for():
    script = {
        "lines": [{"say": "Antes de empezar, quiero ver tu tarea.", "echoes": False}],
        "awaits": "homework_photo",
    }
    platform = Platform(SESSION, Recorder({"instructions": "", "script": script}))

    await platform.start()

    assert platform.opening() == Reply(
        lines=(Line("Antes de empezar, quiero ver tu tarea."),), awaits="homework_photo"
    )


async def test_what_a_photo_of_the_homework_showed_is_told_and_the_engines_answer_returned():
    thanks = {"lines": [{"say": "¡Gracias! Ya vi tu tarea.", "echoes": False}], "awaits": None}
    again = {"lines": [{"say": "Uy, no la pude ver bien.", "echoes": False}]}
    send = Recorder(thanks, {**again, "awaits": "homework_photo"}, {})
    platform = Platform(SESSION, send)

    assert await platform.homework(Reading("read", 3, 0.82)) == Reply(
        lines=(Line("¡Gracias! Ya vi tu tarea."),)
    )
    assert (await platform.homework(Reading("unreadable"))).awaits == "homework_photo"
    # Told, though it had nothing to say: a report the engine was not waiting for.
    assert await platform.homework(Reading("unavailable")) == Reply()

    # The level and the confidence only with a read; never anything of the photo.
    assert send.calls == [
        ("POST", "/v1/agent/session/homework", {"outcome": "read", "level": 3, "confidence": 0.82}),
        ("POST", "/v1/agent/session/homework", {"outcome": "unreadable"}),
        ("POST", "/v1/agent/session/homework", {"outcome": "unavailable"}),
    ]
    assert send.timeouts == [HOMEWORK_TIMEOUT_SECONDS] * 3 and HOMEWORK_TIMEOUT_SECONDS == 3.0


@pytest.mark.parametrize(
    "failure", [RuntimeError("down"), Refused(409), Refused(401), Refused(410), Refused(404)]
)
async def test_a_homework_report_that_is_not_taken_is_none_and_the_session_goes_on(failure):
    send = Recorder(failure, {})
    platform = Platform(SESSION, send)

    assert await platform.homework(Reading("read", 2, 0.9)) is None

    assert not platform.gone
    platform.heard("user", "hola")
    await platform.report_once()
    assert send.calls[-1][1] == "/v1/agent/session/turns"
