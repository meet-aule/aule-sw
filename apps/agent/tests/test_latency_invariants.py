"""The safety invariants, proved on whole sessions: the real worker, session,
tutor and gates, every provider stood in for (``fakes``) and the child
scripted (``latency_harness``). The providers take a twentieth of their real
time; what LiveKit itself waits for is not scaled.

1. Nothing of a reply reaches the child before the turn passed every input gate.
2. Nothing of a reply is heard or shown before the output gate approved it.
3. A gate that fails or is late says no.
4. The physical-safety and refusal flows, their fixed lines and the evals are
   as they were.
5. The child's words reach no log, and nothing a stopped turn produced is kept.
"""

import asyncio
import hashlib
import json
import logging
from dataclasses import dataclass
from pathlib import Path

import latency_harness as harness
import pytest
from fakes import CHILD_WORDS, TRIGGERS, Delays, Played, TurnPlan, World, words_of

from aule_agent import moderation, opinion, physical_safety, replies, safety
from aule_agent.replies import ADULT_HELP_SEQUENCE, MEANWHILE, REPLIES

FAST = Delays(scale=0.05)
AGENT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class Spec:
    """One turn of a scripted session."""

    extra: str = ""
    reply: str = "Muy bien, cuéntame cómo lo pensaste."
    tools: tuple[str, ...] = ()
    hold: float = 0.1
    speech: float = 0.4
    final: bool = True


def violence(text: str = "") -> str:
    return f"{text} {TRIGGERS['violence']}".strip()


ORDINARY = Spec()
# Each session: an ordinary turn first, so that the turn under test is not the
# session's first check (which waits longer for a new connection).
SESSIONS: dict[str, list[Spec]] = {
    "ordinary": [ORDINARY, Spec(reply="Bien. Ahora suma tres más dos."), ORDINARY],
    "redirect": [ORDINARY, Spec(extra=TRIGGERS["violence"])],
    "self_harm_support": [ORDINARY, Spec(extra=TRIGGERS["self_harm"])],
    "child_support": [ORDINARY, Spec(extra=TRIGGERS["minors"])],
    "moderation_down": [ORDINARY, Spec(extra=TRIGGERS["moderation_down"])],
    "moderation_late": [ORDINARY, Spec(extra=TRIGGERS["moderation_slow"])],
    "typesafe_down": [ORDINARY, Spec(extra=TRIGGERS["typesafe_down"])],
    "context_limit": [ORDINARY, Spec(extra="ñ" * 12_500)],
    "clarify": [ORDINARY, Spec(extra=TRIGGERS["unsure"])],
    "second_reader_concern": [ORDINARY, Spec(extra=f"{TRIGGERS['faint']} {TRIGGERS['concern']}")],
    "second_reader_late": [
        ORDINARY,
        Spec(extra=f"{TRIGGERS['unsure_score']} {TRIGGERS['reader_slow']}"),
    ],
    "adult_help": [ORDINARY, *[Spec(extra=TRIGGERS["hazard"])] * 4],
    "reply_stopped": [ORDINARY, Spec(reply=violence("Te voy a decir algo"))],
    "reply_gate_down": [ORDINARY, Spec(reply=f"Algo {TRIGGERS['moderation_down']}")],
    "reply_reader_late": [
        ORDINARY,
        Spec(reply=f"Cuenta {TRIGGERS['unsure_score']} {TRIGGERS['reader_slow']}"),
    ],
    "reply_reader_yes": [ORDINARY, Spec(reply=f"Cuenta las canicas {TRIGGERS['unsure_score']}.")],
    # The hearing never finalizes the last words: the commit times out with
    # an interim pending, and LiveKit warns with it in a field of the record.
    "interim_only": [ORDINARY, Spec(final=False)],
    "meanwhile": [
        ORDINARY,
        Spec(tools=("check_answer", "pose_exercise"), reply="Muy bien, ahora prueba otra."),
        Spec(tools=("show",), reply="Mira la pantalla y dime qué ves."),
    ],
}
# What each session's last turn hears instead of an answer, and the flag it raises.
STOPPED = {
    "redirect": ("redirect", ("moderation_input", "redirect", ["violence"])),
    "self_harm_support": ("self_harm_support", ("moderation_input", "support", ["self_harm"])),
    "child_support": ("child_support", ("moderation_input", "support", ["sexual/minors"])),
    "moderation_down": (
        "unavailable",
        ("moderation_input", "unavailable", ["gate_unavailable"]),
    ),
    "moderation_late": (
        "unavailable",
        ("moderation_input", "unavailable", ["gate_unavailable"]),
    ),
    "typesafe_down": ("unavailable", ("physical_safety", "unavailable", ["gate_unavailable"])),
    "context_limit": ("context_limit", ("physical_safety", "unavailable", ["gate_unavailable"])),
    "clarify": ("clarify", ("physical_safety", "clarify", ["physical_hazard"])),
    "second_reader_concern": (
        "self_harm_support",
        ("moderation_input", "support", ["self_harm"]),
    ),
    "second_reader_late": ("redirect", ("moderation_input", "redirect", ["violence"])),
}
REPLY_STOPPED = {
    "reply_stopped": ("redirect", ("moderation_output", "redirect", ["violence"])),
    "reply_gate_down": (
        "unavailable",
        ("moderation_output", "unavailable", ["gate_unavailable"]),
    ),
    "reply_reader_late": ("redirect", ("moderation_output", "redirect", ["violence"])),
}


def scripted(world: World, specs: list[Spec]) -> list[harness.Turn]:
    turns = []
    for number, spec in enumerate(specs, start=1):
        words = words_of(number, spec.extra)
        world.plans[words] = TurnPlan(
            reply="" if spec.tools else spec.reply,
            tool=spec.tools[0] if spec.tools else None,
            more_tools=spec.tools[1:],
            tool_tokens=12,
            reply_after_tool=spec.reply,
        )
        kind = "tool" if spec.tools else "reply"
        turns.append(
            harness.Turn(
                number, kind, words, spec.speech, spec.hold, *spec.tools[:1], final=spec.final
            )
        )
    return turns


@dataclass
class Run:
    world: World
    results: list[harness.TurnResult]


async def run_all(env: dict[str, str] | None = None) -> tuple[dict[str, Run], list[str]]:
    records = harness.Records()
    root = logging.getLogger()
    level = root.level
    root.addHandler(records)
    root.setLevel(logging.INFO)
    try:
        with harness.offline(env):
            worlds = {name: World(seed=index, delays=FAST) for index, name in enumerate(SESSIONS)}
            runs = await asyncio.gather(
                *(
                    harness.run_session(world, scripted(world, SESSIONS[name]))
                    for name, world in worlds.items()
                )
            )
    finally:
        root.removeHandler(records)
        root.setLevel(level)
    return {name: Run(run.world, run.results) for name, run in zip(worlds, runs, strict=True)}, (
        records.lines
    )


@pytest.fixture(scope="module")
def sessions() -> tuple[dict[str, Run], list[str]]:
    return asyncio.run(run_all())


def spoken(text: str) -> str:
    return " ".join(text.split())


def heard(segments: list[Played]) -> str:
    return spoken(" ".join(text for segment in segments for text in segment.texts))


def kept_words(world: World, words: str) -> list[str]:
    """Where the child's words of a turn were kept: the conversation the
    model reads and the turns reported to the platform."""
    kept = [
        "conversation"
        for item in world.tutor.chat_ctx.items
        if item.type == "message" and words in (item.text_content or "")
    ]
    kept += ["platform" for turn in world.reported_turns if words in turn["content"]]
    return kept


def test_every_ordinary_turn_is_answered_with_the_models_reply(sessions):
    runs, _ = sessions
    run = runs["ordinary"]
    assert [spoken(result.heard()) for result in run.results] == [
        spoken(spec.reply) for spec in SESSIONS["ordinary"]
    ]
    for result in run.results:
        assert result.allowed is True
        assert result.played[0].started_at > result.decided_at
    assert run.world.api_errors == []


@pytest.mark.parametrize("name", STOPPED)
def test_a_stopped_turn_gets_its_fixed_line_after_the_decision_and_nothing_else(sessions, name):
    runs, _ = sessions
    run = runs[name]
    stopped = run.results[-1]
    key, flag = STOPPED[name]

    assert stopped.allowed is False
    # Only the fixed line is heard and read, after the gates decided.
    assert heard(stopped.played) == spoken(REPLIES[key]["es"])
    assert spoken("".join(stopped.shown)) == spoken(REPLIES[key]["es"])
    assert stopped.played[0].started_at >= stopped.decided_at
    # Whatever the model was asked for this turn was closed, and none of it
    # reached the child.
    plan = run.world.plans[words_of(len(run.results), SESSIONS[name][-1].extra)]
    assert spoken(plan.reply) not in heard(stopped.played)
    assert all(call.closed or call.finished_at is not None for call in stopped.calls)
    for call in stopped.calls:
        assert not call.output_text or spoken(call.output_text) not in spoken(
            " ".join(stopped.shown)
        )
    # The child's words of a stopped turn are not kept, and the flag is the gate's own.
    assert kept_words(run.world, words_of(len(run.results), SESSIONS[name][-1].extra)) == []
    assert tuple(run.world.flags[-1]) == flag
    assert all(gate != "moderation_output" for gate, _, _ in run.world.flags)


def test_hazards_in_a_row_get_the_full_line_then_the_shorter_ones_in_turn(sessions):
    runs, _ = sessions
    lines = [heard(result.played) for result in runs["adult_help"].results[1:]]
    keys = [*ADULT_HELP_SEQUENCE, ADULT_HELP_SEQUENCE[1]]
    assert lines == [spoken(REPLIES[key]["es"]) for key in keys]
    assert all(gate == "physical_safety" for gate, _, _ in runs["adult_help"].world.flags)


@pytest.mark.parametrize("name", REPLY_STOPPED)
def test_a_reply_the_output_gate_stops_is_never_heard_or_shown(sessions, name):
    runs, _ = sessions
    run = runs[name]
    result = run.results[-1]
    key, flag = REPLY_STOPPED[name]

    assert result.allowed is True
    assert heard(result.played) == spoken(REPLIES[key]["es"])
    assert spoken("".join(result.shown)) == spoken(REPLIES[key]["es"])
    assert TRIGGERS["violence"] not in " ".join(result.shown)
    assert [tuple(item) for item in run.world.flags] == [flag]


def test_a_clear_yes_from_the_second_reader_lets_a_reply_through(sessions):
    runs, _ = sessions
    result = runs["reply_reader_yes"].results[-1]
    assert heard(result.played) == spoken(SESSIONS["reply_reader_yes"][-1].reply)
    assert runs["reply_reader_yes"].world.flags == []


def test_one_line_while_the_tools_work_per_turn_however_many_tools(sessions):
    runs, _ = sessions
    _, two_tools, one_tool = runs["meanwhile"].results
    first, second = (REPLIES[key]["es"] for key in MEANWHILE[:2])
    assert heard(two_tools.played) == spoken(f"{first} {SESSIONS['meanwhile'][1].reply}")
    assert heard(one_tool.played) == spoken(f"{second} {SESSIONS['meanwhile'][2].reply}")


def test_no_log_line_carries_the_childs_words(sessions):
    _, lines = sessions
    assert lines
    assert not [line for line in lines if CHILD_WORDS in line]


def test_the_tutor_reply_line_is_logged_once_per_answered_turn(sessions):
    runs, lines = sessions
    answered = sum(
        1 for run in runs.values() for result in run.results if result.allowed is not False
    )
    tutor_replies = [line for line in lines if json.loads(line).get("message") == "tutor reply"]
    # A turn with tools logs once per step.
    steps = sum(
        len(SESSIONS["meanwhile"][index].tools) for index in range(len(SESSIONS["meanwhile"]))
    )
    assert len(tutor_replies) == answered + steps


def _digest(value: object) -> str:
    return hashlib.sha256(
        json.dumps(value, sort_keys=True, ensure_ascii=False, default=sorted).encode()
    ).hexdigest()


# The gates' verdicts as they are on main: their providers' models, questions,
# thresholds, timeouts and fixed replies. A change here needs a new evaluation
# (evals/) and a new digest, on purpose.
VERDICTS = {
    "moderation": (
        "e2b081248f383a35fa3b745d02b3a9b702a009bdc84c75550b95151e930bd597",
        lambda: [
            moderation.MODEL,
            moderation.MAX_CHARS,
            moderation.TIMEOUT_SECONDS,
            moderation.INITIAL_TIMEOUT_SECONDS,
            moderation.PROBE_TEXT,
            moderation._PATTERN_DEFINITIONS,
            moderation.THRESHOLDS,
            sorted(moderation.SECOND_READING),
            moderation.SELF_HARM_FAINT_FROM,
            moderation.SELF_HARM_FAINT_BELOW,
        ],
    ),
    "physical_safety": (
        "840611130dec6c745c74af0629dcff0332dd2edfe3ea0898b30b86dda02b427f",
        lambda: [
            physical_safety.MODEL,
            physical_safety.ENDPOINT,
            physical_safety.QUESTION,
            physical_safety.FIRST_TRY_SECONDS,
            physical_safety.SECOND_TRY_SECONDS,
            physical_safety.ALLOW_MAX_RISK,
            physical_safety.HELP_MIN_RISK,
            physical_safety.MAX_BYTES,
            physical_safety.MAX_HISTORY_ITEMS,
            physical_safety.UNKNOWN_AGE,
            physical_safety.GRADE_AGES,
            physical_safety.NAME_STANDIN,
        ],
    ),
    "opinion": (
        "b19c5e7688bc1e8951ceef455da9b4b08bdbe792f444e1ea640fbec22a64c75e",
        lambda: [
            opinion.MODEL,
            opinion.TIMEOUT_SECONDS,
            opinion.MAX_TOKENS,
            opinion.QUESTION,
            opinion.HEARD_QUESTION,
        ],
    ),
    "replies": (
        "4df6d0a8128e6e37a1c9fe9e33bb42ef92b23a13bddc6e84ea966620aa1f75ea",
        lambda: [
            replies.REPLIES,
            replies.ADULT_HELP_SEQUENCE,
            sorted(replies.ANSWERABLE),
            replies.BREAKS,
            replies.MEANWHILE,
        ],
    ),
    "safety": (
        "af5465150a706f359e02732247db1531c26a9d478f457efcd0dc221a4b955abf",
        lambda: [
            sorted(safety.FLAG_GATES),
            sorted(safety.FLAG_ACTIONS),
            safety.FLAG_CATEGORIES,
            safety._PROVIDER_CATEGORY,
            safety.MAX_TUTOR_LINE_CHARS,
        ],
    ),
}
# The evaluations of the gates, read by hand against the real providers, and
# the evaluation of the tutoring.
EVALS = {
    "evals/physical-safety/evaluate.py": (
        "168b85f41f7de436bddb9e0ed5ee8c08caaf488626bc3b6dc1297aed58cc5635"
    ),
    "evals/physical-safety/bilingual-cases.json": (
        "9e7e55d8906a0d6190b2b5a506699a62223cfd6dddf2a1589cf82a54b48f121b"
    ),
    "evals/physical-safety/age-cases.json": (
        "8471c273d816187a5cb16bd834c9c26a4dc3654d35d2560f30507cd2bbcb3012"
    ),
    "evals/physical-safety/prospective-cases.json": (
        "4f6be5e093d9fa455edd2416f682cd6a3eedd9be870af727aa8bf35f4fcb15ef"
    ),
    "evals/physical-safety/turn-recovery-cases.json": (
        "6070be2aab180108994d948a82e24df588975ed009e2424af9908a666341f91f"
    ),
    "evals/second-reading/evaluate.py": (
        "c3772c93094f57598e237f19e36ac006f854adf7d476d6c8e59b36d1d408de7d"
    ),
    "evals/second-reading/cases.json": (
        "d14f404557888ee2c7aa4140fab7acc8eae18bd6c1222be871376c975299e415"
    ),
    # The tutoring evaluation, which runs the real tutor, its tools and both gates.
    "evals/pedagogy/autonomous.py": (
        "087f9dc4b21547d677d28253bf52b90cbda095679a90b87ccf70a505775eb630"
    ),
    "evals/pedagogy/budget.py": (
        "62b7d87916ee2e2b4744176686895b2193f6629674e9ef2520712174bfe98048"
    ),
    "evals/pedagogy/cases.py": ("ce4d7bfc4f3fd6027eb298f6f3394996157ce5f4cc529f65d0b4264b1202a916"),
    "evals/pedagogy/evaluate.py": (
        "2e8880662e1bd56f735ec3fc2b40841f546d5d744512fa710aae40b7c13f54db"
    ),
    "evals/pedagogy/report.py": (
        "9a4c88c3c27b82ca64b60eae543d222d34946262c8cb366e8032c163a97af366"
    ),
    "evals/pedagogy/test_budget.py": (
        "f2a9c61ea8785de0f7c6849806e299d5d8b9e37c3fd6f580cadddd7e120b3904"
    ),
    "evals/pedagogy/checker/Cargo.lock": (
        "b0793b22a5ce89349a1015d5bf67e3c0a666cb1107bbdd7fb25c8b375b9850ea"
    ),
    "evals/pedagogy/checker/Cargo.toml": (
        "9e15c50158309e5359d26f7ec7c4452e888ca7ebc6356abae61a9a564c460a3d"
    ),
    "evals/pedagogy/checker/src/main.rs": (
        "f821e624051f1dba06f7492b465c4290ff91bb2eb471db9f3f859de93c23a619"
    ),
}


@pytest.mark.parametrize("module", VERDICTS)
def test_the_gates_verdicts_are_those_of_main(module):
    expected, constants = VERDICTS[module]
    assert _digest(constants()) == expected


@pytest.mark.parametrize("path", EVALS)
def test_the_evaluations_are_those_of_main(path):
    assert hashlib.sha256((AGENT / path).read_bytes()).hexdigest() == EVALS[path]
