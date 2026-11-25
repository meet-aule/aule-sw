"""The examples judge's calibration, offline: its labelled turns and its gate."""

import json
from types import SimpleNamespace

import calibrate
import httpx2 as httpx
import meaning
import pytest

SESSIONS = calibrate.load()
LABELS = [(s["id"], label) for s in SESSIONS for label in s["labels"]]


def test_every_turn_is_labelled_once_and_each_kind_is_covered():
    ids = [session["id"] for session in SESSIONS]
    assert len(ids) == len(set(ids))
    for session in SESSIONS:
        numbers = [turn["turn"] for turn in session["turns"]]
        assert numbers == list(range(1, len(numbers) + 1))
        assert {"run", "file", "file_sha256", "exercise", "exact_answer"} <= set(session)
        # A turn of a run comes with the file it was read from; a hand-written
        # one says so.
        if session.get("synthetic"):
            assert session["run"] == "hand-written" and session["file"] is None
        else:
            assert session["file"] and len(session["file_sha256"]) == 64
        assert sorted(label["turn"] for label in session["labels"]) == numbers
        for label in session["labels"]:
            assert label["expect"] in calibrate.EXPECTED
            assert isinstance(label["must"], bool) and label["why"]
            if label["must"]:
                assert label["expect"] in ("changes", "keeps")
                assert session["turns"][label["turn"] - 1]["tutor"].strip()
    counts = {e: sum(label["expect"] == e for _, label in LABELS) for e in calibrate.EXPECTED}
    assert counts["changes"] >= 20 and counts["keeps"] >= 30 and counts["none"] >= 40
    assert counts["ambiguous"] <= 2


def test_the_hand_written_turns_bring_the_failures_the_runs_did_not_show():
    written = {s["id"].removeprefix("hand-written/"): s for s in SESSIONS if s.get("synthetic")}
    expected = {
        "division-told-as-taking-a-part": "changes",
        "dividend-and-divisor-swapped": "changes",
        "grouping-changed": "changes",
        "multiplying-as-one-group": "changes",
        "story-of-the-mistake": "changes",
        "worked-example-other-numbers": "keeps",
        "buying-that-adds-up": "keeps",
        "number-line": "keeps",
        "comparing-pieces": "keeps",
    }
    assert {key: written[key]["labels"][1]["expect"] for key in expected} == expected


def test_the_candy_story_must_fail_and_the_good_story_of_the_same_exercise_must_pass():
    must = {(session, label["turn"]): label["expect"] for session, label in LABELS if label["must"]}
    assert must[("aule-tutor-fixes-20261125/math-071-fixed-0", 2)] == "changes"
    assert must[("aule-pedagogy-20261125/math-071-baseline-0", 2)] == "keeps"


def test_the_fixtures_name_no_path_of_anyone_s_machine():
    text = calibrate.FIXTURES.read_text()
    assert "/Users/" not in text and "/private/" not in text and "/tmp/" not in text


def example(turn, verdict):
    return dict(
        turn=turn,
        quote="q",
        stands_for="s",
        story_expression="e",
        whole_story="w",
        roles="r",
        verdict=verdict,
        reason="why",
    )


def judged(*examples, status="ok"):
    return dict(model=meaning.MODEL, status=status, examples=list(examples), changed=None)


def answers(wrong=(), status=None):
    """The judge as if it read every labelled turn right, but for ``wrong``:
    (session, turn, verdict) given instead."""
    found = {}
    for session in SESSIONS:
        items = []
        for label in session["labels"]:
            given = next(
                (v for s, t, v in wrong if (s, t) == (session["id"], label["turn"])),
                {"changes": "changes", "keeps": "keeps", "none": None, "ambiguous": None}[
                    label["expect"]
                ],
            )
            if given is not None:
                items.append(example(label["turn"], given))
        found[session["id"]] = judged(*items)
    if status is not None:
        found[SESSIONS[0]["id"]] = judged(status=status)
    return found


def run_gate(found):
    return calibrate.gate(calibrate.outcomes(SESSIONS, found), found)


def labelled(expect, must):
    return [
        (s, label["turn"])
        for s, label in LABELS
        if label["expect"] == expect and label["must"] is must
    ]


def test_a_judge_that_reads_every_turn_right_passes():
    result = run_gate(answers())
    assert result["passed"] and result["reasons"] == []
    assert result["recall"] == result["specificity"] == 1.0


def test_one_slip_off_the_must_turns_is_allowed_and_a_must_turn_is_not():
    (session, turn), *_ = labelled("changes", False)
    assert run_gate(answers([(session, turn, "unclear")]))["passed"]

    (session, turn), *_ = labelled("changes", True)
    assert not run_gate(answers([(session, turn, "keeps")]))["passed"]
    (session, turn), *_ = labelled("keeps", True)
    assert not run_gate(answers([(session, turn, "unclear")]))["passed"]


def test_two_misses_or_two_false_alarms_fail():
    first, second, *_ = labelled("changes", False)
    missed = run_gate(answers([(*first, "unclear"), (*second, "keeps")]))
    assert not missed["passed"] and missed["misses"] == 2

    first, second, *_ = labelled("keeps", False)
    alarmed = run_gate(answers([(*first, "changes"), (*second, "changes")]))
    assert not alarmed["passed"] and alarmed["false_alarms"] == 2


def test_false_alarms_count_on_every_turn_the_first_and_the_last_included():
    none = [(s, label["turn"]) for s, label in LABELS if label["expect"] == "none"]
    first = next(turn for turn in none if turn[1] == 1)
    last = next(turn for turn in none if turn[1] == 3)
    alarmed = run_gate(answers([(*first, "changes"), (*last, "changes")]))
    assert not alarmed["passed"] and alarmed["false_alarms"] == 2


def test_an_ambiguous_turn_is_listed_and_not_scored():
    ambiguous = [(s, label["turn"]) for s, label in LABELS if label["expect"] == "ambiguous"]
    assert ambiguous
    for verdict in ("changes", "keeps", "unclear"):
        found = answers([(*turn, verdict) for turn in ambiguous])
        outcomes = calibrate.outcomes(SESSIONS, found)
        assert {o["outcome"] for o in outcomes if o["expect"] == "ambiguous"} == {"not_scored"}
        assert calibrate.gate(outcomes, found)["passed"]


def test_the_judge_counts_only_when_it_passed_every_run():
    passed, failed = run_gate(answers()), run_gate(answers(status="invalid"))
    assert calibrate.overall([passed] * calibrate.RUNS)["passed"]
    assert not calibrate.overall([passed, failed])["passed"]
    assert not calibrate.overall([passed])["passed"]


@pytest.mark.parametrize("status", ["ungrounded", "invalid", "truncated", "refused", "error"])
def test_any_judge_failure_fails(status):
    result = run_gate(answers(status=status))
    assert not result["passed"] and any(status in reason for reason in result["reasons"])


async def test_the_preview_calls_nothing(monkeypatch, capsys):
    async def refuse(*_):
        raise AssertionError("no call without --live")

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", refuse)
    args = SimpleNamespace(fixtures=str(calibrate.FIXTURES), live=False)

    assert await calibrate.main(args) == 0

    printed = capsys.readouterr().out
    assert f'"calls": {len(SESSIONS) * calibrate.RUNS}' in printed
    assert '"reservation_bound_usd"' in printed


async def test_a_live_calibration_against_a_stand_in_writes_its_result_once(tmp_path, monkeypatch):
    # The API itself is never reached: the transport under the metered one
    # answers each session from its labels, quoting the tutor's own words.
    sent = []

    async def answer_from_the_labels(self, request):
        body = json.loads(await request.aread())
        sent.append(body)
        turns = json.loads(body["messages"][0]["content"])["turns"]
        session = next(s for s in SESSIONS if s["turns"] == turns)
        items = [
            example(label["turn"], label["expect"] if label["expect"] != "ambiguous" else "unclear")
            | dict(quote=turns[label["turn"] - 1]["tutor"][:24])
            for label in session["labels"]
            if label["expect"] != "none"
        ]
        message = dict(
            id="msg",
            type="message",
            role="assistant",
            model=meaning.MODEL,
            content=[{"type": "text", "text": json.dumps({"examples": items})}],
            stop_reason="end_turn",
            stop_sequence=None,
            usage={"input_tokens": 1000, "output_tokens": 400},
        )
        return httpx.Response(200, json=message)

    monkeypatch.setattr(httpx.AsyncHTTPTransport, "handle_async_request", answer_from_the_labels)
    monkeypatch.setenv("ANTHROPIC_API_KEY", "test")
    args = SimpleNamespace(
        fixtures=str(calibrate.FIXTURES),
        live=True,
        concurrency=4,
        output=str(tmp_path),
        credentials=None,
        budget=20,
    )

    assert await calibrate.main(args) == 0
    assert await calibrate.main(args) == 0

    # One call per session and run, made once: the second calibration reads
    # the first one's result.
    assert len(sent) == len(SESSIONS) * calibrate.RUNS
    assert {body["model"] for body in sent} == {"claude-haiku-5-5"}
    assert all(body["thinking"] == {"type": "disabled"} for body in sent)
    saved = json.loads((tmp_path / "calibration.json").read_text())
    assert saved["gate"]["passed"] and len(saved["gate"]["runs"]) == calibrate.RUNS
    assert all(run["recall"] == 1.0 for run in saved["gate"]["runs"])
    assert saved["hashes"]["model"] == meaning.MODEL and saved["hashes"]["runs"] == calibrate.RUNS
    assert all(len(run["turns"]) == len(LABELS) for run in saved["runs"])
    assert saved["budget"]["calls"] == len(SESSIONS) * calibrate.RUNS
    assert saved["budget"]["unreconciled_calls"] == 0
