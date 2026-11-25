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
from fakes import (
    CHILD_WORDS,
    TRIGGERS,
    Delays,
    Played,
    Spread,
    TurnPlan,
    World,
    _last_user,
    words_of,
)
from test_metrics import fits_the_platform

from aule_agent import moderation, opinion, physical_safety, replies, safety
from aule_agent.prompts import response_language
from aule_agent.replies import ADULT_HELP_SEQUENCE, MEANWHILE, REPLIES
from aule_agent.timing import STAGES

# The input gates take longer than the model takes to write its whole reply,
# so with early replies the reply is written, and waiting, when they decide.
FAST = Delays(scale=0.05, moderation=Spread(6.0, 8.0), typesafe=Spread(6.0, 8.0))
# The defaults, the reply asked early (D1), and the reply voiced ahead (D3)
# with the notes after the history (D2).
MODES = {
    "early_off": {},
    "early_on": {"AULE_EARLY_REPLY": "1"},
    "voice_ahead": {"AULE_VOICE_AHEAD": "1", "AULE_NOTES_AFTER_HISTORY": "1"},
}
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
    # A word said right after the release, while the page's tail keeps the
    # microphone on, and whether the voice detector hears it (a soft one only
    # the hearing hears).
    tail: str | None = None
    tail_vad: bool = True
    # What the model writes in a step with a tool before it calls the tool.
    preamble: str = ""


def violence(text: str = "") -> str:
    return f"{text} {TRIGGERS['violence']}".strip()


ORDINARY = Spec()
# A worked example before its question: every paragraph of a reply is said.
EXAMPLE = "Imagina dos pizzas cortadas en mitades. ¿Cuántos pedazos hay?"
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
    # The child holds the button well after speaking, every time.
    "held": [Spec(hold=1.0), Spec(hold=1.2), Spec(hold=0.9)],
    # A word said as the button goes up, after a pause the voice detector
    # took for the end of speech.
    "tail_word": [ORDINARY, Spec(hold=0.8, tail="y medio")],
    # The same word, too soft for the voice detector: only the hearing hears it.
    "tail_word_stt_only": [ORDINARY, Spec(hold=0.8, tail="y medio", tail_vad=False)],
    "meanwhile": [
        ORDINARY,
        Spec(tools=("check_answer", "pose_exercise"), reply="Muy bien, ahora prueba otra."),
        Spec(
            tools=("show",),
            reply="Mira la pantalla y dime qué ves.",
            preamble="Primero lo registro y luego te lo muestro. Así lo ves mejor.",
        ),
    ],
    # A reply of two paragraphs, judged and heard whole.
    "paragraphs": [
        ORDINARY,
        Spec(reply=f"{EXAMPLE}\n\nAhora dime si eso es multiplicar o dividir."),
    ],
    # A reply the output gate stops for its last paragraph, once the voice has
    # made its first sentence.
    "reply_stopped_later": [ORDINARY, Spec(reply=f"{EXAMPLE}\n\n{violence('Y ahora')}")],
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
            preamble=spec.preamble,
        )
        kind = "tool" if spec.tools else "reply"
        turns.append(
            harness.Turn(
                number,
                kind,
                words,
                spec.speech,
                spec.hold,
                *spec.tools[:1],
                tail_word=spec.tail,
                tail_after=0.02,
                tail_seconds=0.15,
                tail_vad=spec.tail_vad,
                # Finalized only after end_turn came: the commit has to wait for it.
                tail_final=0.3,
                final=spec.final,
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
def modes() -> dict[str, tuple[dict[str, Run], list[str]]]:
    return {mode: asyncio.run(run_all(env)) for mode, env in MODES.items()}


@pytest.fixture(scope="module", params=list(MODES))
def sessions(request, modes) -> tuple[dict[str, Run], list[str]]:
    """Every invariant holds with early replies off and on."""
    return modes[request.param]


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


# With the microphone open, the voice detector ends each turn (``harness.MODES``).
OPEN_MIC = ("ordinary", "redirect", "meanwhile")


@pytest.fixture(scope="module")
def open_mic() -> dict[str, Run]:
    async def run() -> dict[str, Run]:
        with harness.offline(mode="open-mic"):
            worlds = {name: World(seed=index, delays=FAST) for index, name in enumerate(OPEN_MIC)}
            runs = await asyncio.gather(
                *(
                    harness.run_session(world, scripted(world, SESSIONS[name]), mode="open-mic")
                    for name, world in worlds.items()
                )
            )
        return {name: Run(run.world, run.results) for name, run in zip(worlds, runs, strict=True)}

    return asyncio.run(run())


def test_with_the_microphone_open_no_words_reach_the_model_before_the_gates_let_them_through(
    open_mic,
):
    for name, run in open_mic.items():
        for result in run.results:
            assert result.decided_at is not None, name
            for call in result.calls:
                if result.words in json.dumps(call.kwargs["messages"], ensure_ascii=False):
                    assert result.allowed, (name, result.number)
                    assert call.opened_at >= result.decided_at, (name, result.number)
            assert all(s.started_at >= result.decided_at for s in result.played), name
        assert harness.unapproved(run.world) == 0, name
        assert run.world.api_errors == [], name
    stopped = open_mic["redirect"].results[-1]
    assert stopped.allowed is False and stopped.calls == []
    assert heard(stopped.played) == spoken(REPLIES["redirect"]["es"])
    answered = [heard(r.played) for r in open_mic["ordinary"].results]
    assert answered == [spoken(spec.reply) for spec in SESSIONS["ordinary"]]


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


def test_nothing_is_heard_before_the_output_gate_approved_it_voiced_ahead_or_not(sessions):
    runs, _ = sessions
    for name, run in runs.items():
        world = run.world
        assert harness.unapproved(world) == 0, name
        fixed = harness.FIXED_LINES | set(harness._engine_lines(world))
        for segment in world.played[1:]:
            for text in segment.texts:
                if any(text.strip() in line for line in fixed):
                    continue
                approvals = [at for at, said, allowed in world.judged if allowed and text in said]
                # The sentence played was part of a text the gate had approved by then.
                assert approvals and min(approvals) <= segment.started_at, (name, text)


def voiced_before(world: World, sentence: str, moment: float) -> bool:
    """Whether the voice was given ``sentence`` before ``moment``."""
    return any(at < moment and said == sentence for at, said in world.voiced)


@pytest.mark.parametrize("name", REPLY_STOPPED)
def test_what_the_voice_made_of_a_reply_the_output_gate_stops_is_never_heard(modes, name):
    for mode, (runs, _) in modes.items():
        run = runs[name]
        result = run.results[-1]
        reply = SESSIONS[name][-1].reply
        (decided_at,) = [at for at, said, allowed in run.world.judged if said == reply]
        made = [at for at, sentence in run.world.made if sentence == reply]

        assert heard(result.played) == spoken(REPLIES[REPLY_STOPPED[name][0]]["es"]), mode
        if mode == "voice_ahead":
            # The voice had made it before the gate said no: the gate was slower.
            assert made and made[0] < decided_at
            assert run.world.tutor.voiced_ahead["sentences_dropped"] >= 1
        else:
            # The voice's provider never got it.
            assert not voiced_before(run.world, reply, float("inf")), mode


def test_nothing_of_a_step_with_a_tool_ever_reaches_the_voice(sessions):
    runs, _ = sessions
    run = runs["meanwhile"]
    unsaid = "Primero"
    assert not [sentence for _, sentence in run.world.voiced if unsaid in sentence]
    assert unsaid not in "".join(text for result in run.results for text in result.shown)
    assert run.world.tutor.voiced_ahead["sentences_dropped"] == 0


def test_a_reply_of_two_paragraphs_is_heard_whole_after_the_gate_approved_all_of_it(modes):
    for mode, (runs, _) in modes.items():
        run = runs["paragraphs"]
        result = run.results[-1]
        reply = SESSIONS["paragraphs"][-1].reply
        (approved_at,) = [at for at, said, allowed in run.world.judged if allowed and said == reply]

        assert heard(result.played) == spoken(reply), mode
        assert result.played[0].started_at >= approved_at, mode
        voiced = run.world.tutor.voiced_ahead
        if mode == "voice_ahead":
            # Said with what the voice made ahead, on every turn: a paragraph
            # break dropped nothing.
            assert voiced["sentences_said"] == len(SESSIONS["paragraphs"])
            assert voiced["sentences_dropped"] == 0
        else:
            assert voiced["sentences_said"] == voiced["sentences_dropped"] == 0, mode
            first = "Imagina dos pizzas cortadas en mitades."
            assert not voiced_before(run.world, first, approved_at), mode


def test_a_reply_stopped_for_its_last_paragraph_is_never_heard_not_even_its_first_sentence(
    modes,
):
    for mode, (runs, _) in modes.items():
        run = runs["reply_stopped_later"]
        result = run.results[-1]
        reply = SESSIONS["reply_stopped_later"][-1].reply
        first = "Imagina dos pizzas cortadas en mitades."
        (decided_at,) = [at for at, said, allowed in run.world.judged if said == reply]
        made = [at for at, sentence in run.world.made if sentence == first]

        assert heard(result.played) == spoken(REPLIES["redirect"]["es"]), mode
        assert first not in "".join(result.shown), mode
        assert [tuple(item) for item in run.world.flags] == [
            ("moderation_output", "redirect", ["violence"])
        ], mode
        if mode == "voice_ahead":
            # The voice had made the first sentence before the gate said no to the reply.
            assert made and made[-1] < decided_at
            assert run.world.tutor.voiced_ahead["sentences_dropped"] >= 1
        else:
            assert not voiced_before(run.world, first, float("inf")), mode


def test_a_tool_steps_line_is_the_one_voiced_after_the_opening(sessions):
    runs, _ = sessions
    world = runs["meanwhile"].world
    voiced = [sentence for _, sentence in world.voiced]
    # Each line went to the voice once, when the session began, and was
    # replayed for both turns that called a tool.
    assert all(voiced.count(REPLIES[key]["es"]) == 1 for key in MEANWHILE)
    assert world.tutor.voiced_ahead["lines_said"] == 2


def test_what_is_shown_is_what_is_heard(sessions):
    runs, _ = sessions

    def letters(text: str) -> str:
        return "".join(text.split())

    for name, run in runs.items():
        for result in run.results:
            assert letters("".join(result.shown)) == letters(result.heard()), (name, result.number)


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


def test_a_button_held_after_speaking_commits_at_once_with_every_word(sessions):
    runs, _ = sessions
    run = runs["held"]
    assert [heard(result.played) for result in run.results] == [
        spoken(spec.reply) for spec in SESSIONS["held"]
    ]
    assert run.world.typesafe_asked == [
        words_of(number) for number in range(1, len(SESSIONS["held"]) + 1)
    ]
    # Nothing was left to hear: the commit did not wait for a final.
    assert run.world.metrics["commit_ms_p90"] < 300


@pytest.mark.parametrize("name", ["tail_word", "tail_word_stt_only"])
def test_a_word_said_as_the_button_goes_up_is_waited_for(sessions, name):
    runs, _ = sessions
    run = runs[name]
    *_, heard_last = run.world.typesafe_asked
    assert heard_last == f"{words_of(2)} y medio"
    # No word came after its turn was committed.
    assert run.world.metrics["stt_finals_after_commit"] == 0


def test_words_still_interim_at_the_release_are_waited_for_then_committed_as_they_stand(
    sessions,
):
    runs, _ = sessions
    run = runs["interim_only"]
    late = run.results[-1]
    # The hearing's last interim held three of the five words.
    assert run.world.typesafe_asked[-1] == " ".join(words_of(2).split()[:3])
    assert late.allowed and late.played
    # The commit waited for a final that never came.
    assert run.world.metrics["commit_ms_p90"] >= 800


def test_every_press_readies_the_gates_with_their_probe_requests_only(sessions):
    runs, _ = sessions
    for run in runs.values():
        presses = len(run.results)
        warm_ups = run.world.warmups
        # Each press: one word on moderation's free endpoint and two lists of models.
        assert run.world.moderated.count(moderation.PROBE_TEXT) >= presses
        assert warm_ups["typesafe"] >= presses and warm_ups["reader"] >= presses
        # Nothing of the child went with them.
        assert all(utterance != moderation.PROBE_TEXT for utterance in run.world.typesafe_asked)


def test_each_session_warms_the_prompt_cache_once_with_no_childs_words(sessions):
    runs, _ = sessions
    for name, run in runs.items():
        warm, *calls = run.world.model_calls
        assert warm.kwargs["stream"] is False and warm.kwargs["max_tokens"] == 0, name
        assert CHILD_WORDS not in json.dumps(warm.kwargs, ensure_ascii=False)
        assert all(call.kwargs["stream"] is True for call in calls)
        if calls:
            # The first reply reads what the warm-up wrote.
            assert calls[0].cache_read >= warm.cache_write > 0, name


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


def test_the_numbers_each_session_ends_with_fit_what_the_platform_keeps(sessions):
    runs, _ = sessions
    for run in runs.values():
        fits_the_platform(run.world.metrics)
    # A session of ordinary turns times every stage.
    ordinary = runs["ordinary"].world.metrics
    assert ordinary["turns_staged"] == len(SESSIONS["ordinary"])
    assert all(f"{stage}_ms_p50" in ordinary for stage in STAGES)


def test_an_early_reply_to_a_stopped_turn_is_written_closed_and_never_reaches_the_child(modes):
    off, _ = modes["early_off"]
    on, _ = modes["early_on"]
    for name in STOPPED:
        assert off[name].results[-1].calls == [], name
        stopped = on[name].results[-1]
        (call,) = stopped.calls
        # The model wrote all of it before the gates said no.
        assert call.finished_at is not None and call.finished_at < stopped.decided_at, name
        assert call.closed and call.output_text
        assert spoken(call.output_text) not in heard(stopped.played)
        assert spoken(call.output_text) not in spoken("".join(stopped.shown))


@pytest.mark.parametrize("mode", ["early_on", "voice_ahead"])
def test_early_replies_change_nothing_the_child_hears_reads_or_the_platform_keeps(modes, mode):
    off, _ = modes["early_off"]
    on, _ = modes[mode]
    for name in SESSIONS:
        assert [heard(r.played) for r in on[name].results] == [
            heard(r.played) for r in off[name].results
        ], name
        assert [spoken("".join(r.shown)) for r in on[name].results] == [
            spoken("".join(r.shown)) for r in off[name].results
        ], name
        assert on[name].world.flags == off[name].world.flags, name
        assert [t["content"] for t in on[name].world.reported_turns] == [
            t["content"] for t in off[name].world.reported_turns
        ], name


def test_an_answered_turn_asks_the_model_once_per_step_and_a_stopped_one_once_more(modes):
    off, _ = modes["early_off"]
    on, _ = modes["early_on"]
    for name in SESSIONS:
        for before, after in zip(off[name].results, on[name].results, strict=True):
            extra = 0 if before.allowed else 1
            assert len(after.calls) == len(before.calls) + extra, (name, before.number)
        # The dropped call is paid, and counted as a call and as one dropped;
        # it is no turn.
        stopped = sum(1 for r in off[name].results if r.allowed is False)
        metrics_off, metrics_on = off[name].world.metrics, on[name].world.metrics
        assert metrics_on["llm_calls"] == metrics_off["llm_calls"] + stopped, name
        assert metrics_on["early_calls_dropped"] == stopped, name
        assert "early_calls_dropped" not in metrics_off, name
        for key in ("turns_staged", "replies_timed"):
            assert metrics_on.get(key) == metrics_off.get(key), (name, key)
        used = on[name].world.tutor.early_replies
        assert used["dropped"] == stopped, name


def _blocks(request: dict) -> list[str]:
    """A request as the cache reads it, tools, system and messages in that
    order, one block at a time as the client serializes it, without the cache
    markers and the notes (an unmarked last system block or a system message)."""

    def plain(value: object) -> object:
        if isinstance(value, dict):
            return {k: plain(v) for k, v in value.items() if k != "cache_control"}
        if isinstance(value, list):
            return [plain(item) for item in value]
        return value

    def serialized(value: object) -> str:
        return json.dumps(plain(value), ensure_ascii=False, separators=(",", ":"))

    blocks = [serialized(tool) for tool in request.get("tools") or []]
    blocks += [serialized(b) for b in request.get("system") or [] if "cache_control" in b]
    for message in request["messages"]:
        if message["role"] == "system":
            continue
        content = message["content"]
        for block in [{"type": "text", "text": content}] if isinstance(content, str) else content:
            blocks.append(serialized({"role": message["role"], **block}))
    return blocks


@pytest.mark.parametrize("mode", ["early_off", "voice_ahead"])
def test_each_request_is_the_one_before_it_byte_for_byte_with_more_history(modes, mode):
    # The notes at the end of the system prompt, and after the history (D2).
    runs, _ = modes[mode]
    pairs = 0
    for name, run in runs.items():
        streamed = [call.kwargs for call in run.world.model_calls if call.kwargs["stream"]]
        plan_changed = 0
        for before, after in zip(streamed, streamed[1:], strict=False):
            older, newer = _blocks(before), _blocks(after)
            tools = len(before.get("tools") or [])
            # Tools and rules never change; the student's part only once, with a late plan.
            assert newer[: tools + 1] == older[: tools + 1], name
            if newer[tools + 1] != older[tools + 1]:
                plan_changed += 1
                assert newer[tools + 2 :][: len(older) - tools - 2] == older[tools + 2 :], name
            else:
                assert "".join(newer).startswith("".join(older)), name
                assert newer[: len(older)] == older, name
            pairs += 1
        assert plan_changed <= 1, name
    # Not vacuous: the sessions make some eighteen pairs of requests.
    assert pairs >= 15


# Engine sessions: the engine sets new rules for talk on every turn the model
# answers, in the hook, after LiveKit copied the turn's context for its reply.
PLACEMENTS = {"system": {}, "after_history": {"AULE_NOTES_AFTER_HISTORY": "1"}}


def engine_turns(world: World) -> list[harness.Turn]:
    """Off the script with new rules, a line of the script, then off the
    script twice more with new rules, the first with a tool."""
    turns = []
    for number, tool in ((1, None), (2, "script"), (3, "show"), (4, None)):
        words = words_of(number)
        if tool == "script":
            line = {"say": f"Pregunta {number}.", "echoes": False}
            world.platform.scripted_turns[words] = {"lines": [line]}
            turns.append(harness.Turn(number, "scripted", words, 0.4, 0.1))
            continue
        world.platform.scripted_turns[words] = {"converse": f"Regla {number}: sin pistas ahora."}
        world.plans[words] = TurnPlan(
            reply="" if tool else ORDINARY.reply,
            tool=tool,
            tool_tokens=12,
            reply_after_tool=ORDINARY.reply,
        )
        turns.append(harness.Turn(number, "off_script", words, 0.4, 0.1, tool))
    return turns


@pytest.fixture(scope="module")
def engine_sessions() -> dict[str, list[World]]:
    async def run(env: dict[str, str]) -> list[World]:
        with harness.offline(env):
            worlds = [World(seed=index, delays=FAST, mix="engine") for index in range(4)]
            runs = await asyncio.gather(
                *(harness.run_session(w, engine_turns(w), gap=(0.0, 0.05)) for w in worlds)
            )
        return [run.world for run in runs]

    return {name: asyncio.run(run(env)) for name, env in PLACEMENTS.items()}


@pytest.mark.parametrize("placement", list(PLACEMENTS))
def test_in_engine_sessions_each_reply_has_its_turns_rules_and_the_prefix_stays(
    engine_sessions, placement
):
    rule = response_language("es")
    answered = pairs = 0
    for world in engine_sessions[placement]:
        streamed = [call.kwargs for call in world.model_calls if call.kwargs["stream"]]
        for request in streamed:
            if placement == "after_history":
                notes = request["messages"][-1]
                assert notes["role"] == "system", world.seed
                told = notes["content"]
            else:
                notes = request["system"][-1]
                assert "cache_control" not in notes, world.seed
                told = notes["text"]
            # The language rule ends every request, once.
            assert told.endswith(rule) and told.count(rule) == 1, world.seed
            # The rules the engine set for the turn this request answers: the
            # child's last words in it.
            text = _last_user(request)[0]
            words = max((w for w in world.platform.scripted_turns if w in text), key=text.rfind)
            assert world.platform.scripted_turns[words]["converse"] in told, world.seed
            answered += 1
        plan_changed = 0
        for before, after in zip(streamed, streamed[1:], strict=False):
            older, newer = _blocks(before), _blocks(after)
            tools = len(before.get("tools") or [])
            # Tools and rules never change; the student's part only once, with a late plan.
            assert newer[: tools + 1] == older[: tools + 1], world.seed
            if newer[tools + 1] != older[tools + 1]:
                plan_changed += 1
                assert newer[tools + 2 :][: len(older) - tools - 2] == older[tools + 2 :]
            else:
                assert newer[: len(older)] == older, world.seed
            pairs += 1
        assert plan_changed <= 1, world.seed
    # Not vacuous: four replies in each session, each to a turn whose rules
    # had just changed (one a tool's two steps).
    assert answered == 16 and pairs == 12, (answered, pairs)


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
