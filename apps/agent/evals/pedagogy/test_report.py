import json

import report

JUDGED = {key: False for key in report.BAD} | {key: True for key in report.GOOD}
# The examples judge found no example in the session.
NO_EXAMPLE = dict(model="claude-haiku-5-5", status="ok", examples=[], changed=False, unclear=0)


def turn(open_before=True, kind="answer", by=("code",), code=True, calls=(7,), allowed=True):
    events = []
    if code:
        events.append({"type": "function_call", "name": "check_answer", "call_id": "aule_check_1"})
    return dict(
        student="x",
        assistant=["y"],
        error=None,
        input_allowed=allowed,
        seconds=1.0,
        tools=[{"tool": "check_answer", "exercise": exercise} for exercise in calls],
        function_events=events,
        check=dict(open_before=open_before, kind=kind, by=list(by), exercise=7),
    )


def row(name, turns, split="regression", arm="replay", judge=JUDGED, examples=NO_EXAMPLE):
    saved = dict(id=name, arm=arm, repetition=0, split=split, turns=turns, errors=[], judge=judge)
    if examples is not None:
        saved["examples"] = examples
    return saved


def write(directory, *rows):
    (directory / "cost.json").write_text(
        json.dumps(
            dict(
                usage_based_estimate_usd=0.1,
                unreconciled_upper_bound_usd=0.0,
                committed_upper_bound_usd=0.1,
            )
        )
    )
    (directory / "manifest-replay-replay-3-1.json").write_text(json.dumps({"cases": 3}))
    for each in rows:
        (directory / f"{each['id']}-{each['arm']}-0.json").write_text(json.dumps(each))


def test_a_session_passes_only_with_every_answer_checked_once(tmp_path):
    complete = row(
        "complete",
        [
            turn(),
            turn(kind="help"),
            # Left to the model, which checked it itself; nothing open; a stopped turn.
            turn(kind="left", by=("model",), code=False),
            turn(open_before=False, kind=None, by=(), code=False, calls=()),
            turn(kind="answer", by=(), code=False, calls=(), allowed=False),
        ],
    )
    unchecked = row("unchecked", [turn(), turn(kind="help", by=(), code=False, calls=())])
    twice = row("twice", [turn(by=("code",), calls=(7, 7))])
    posed = row(
        "posed",
        [turn(open_before=False, kind="answer", by=("pose", "reused"), code=False, calls=(8,))],
    )
    write(tmp_path, complete, unchecked, twice, posed)

    built = report.build(tmp_path)

    group = built["groups"]["regression/replay"]
    assert group["sessions"] == 4 and group["legacy_passes"] == 4
    assert (group["passes"], group["checks_complete"], group["checks_measured"]) == (2, 2, 4)
    assert group["open_turns"] == 6
    assert (group["code_checked"], group["model_checked"], group["left_to_model"]) == (4, 1, 1)
    assert (group["required_unchecked"], group["double_checks"], group["pose_checked"]) == (1, 1, 1)
    assert {failure["id"] for failure in built["failures"]} == {"unchecked", "twice"}


def test_a_check_the_checker_could_not_answer_is_counted_apart_and_never_as_checked(tmp_path):
    failed = turn()
    failed["check"]["failed"] = True
    helped = turn(kind="help")
    helped["check"]["failed"] = True
    write(tmp_path, row("not-checked", [failed, helped, turn()]))

    group = report.build(tmp_path)["groups"]["regression/replay"]

    assert (group["code_checked"], group["checker_failures"], group["required_unchecked"]) == (
        1,
        2,
        2,
    )
    assert group["checks_complete"] == 0


def test_homework_the_student_brings_must_be_checked_in_its_first_turn(tmp_path):
    def brought(name, *by, failed=False):
        first = turn(open_before=False, kind=None, by=by, code=False, calls=(1,) if by else ())
        first["check"]["failed"] = failed
        saved = row(name, [first, turn(kind="help"), turn()])
        saved["posed"] = False
        return saved

    write(
        tmp_path,
        brought("after-the-pose", "pose"),
        brought("by-the-model", "model"),
        brought("never-posed"),
        brought("not-answered", "pose", failed=True),
    )

    built = report.build(tmp_path)

    group = built["groups"]["regression/replay"]
    assert (group["checks_measured"], group["checks_complete"]) == (4, 2)
    unchecked = {f["id"] for f in built["failures"] if not f["checks"]["complete"]}
    assert unchecked == {"never-posed", "not-answered"}


def test_a_turn_with_no_record_leaves_its_session_measured_and_incomplete(tmp_path):
    timed_out = {key: value for key, value in turn().items() if key != "check"}
    write(tmp_path, row("timed-out", [turn(), timed_out, turn()]))

    group = report.build(tmp_path)["groups"]["regression/replay"]

    assert (group["checks_measured"], group["checks_complete"], group["unrecorded"]) == (1, 0, 1)


def test_a_session_saved_before_the_checks_is_not_measured_and_not_passed(tmp_path):
    old = row(
        "math-071",
        [{k: v for k, v in turn().items() if k != "check"}] * 3,
        split="holdout",
        arm="fixed",
        examples=None,
    )
    write(tmp_path, old)

    built = report.build(tmp_path)
    report.render(built, tmp_path)

    group = built["groups"]["holdout/fixed"]
    assert (group["legacy_passes"], group["passes"], group["checks_measured"]) == (1, 0, 0)
    assert group["examples_measured"] == 0
    markdown = (tmp_path / "report.md").read_text()
    assert "| holdout/fixed | not measured |" in markdown
    assert "| 1 | not measured | not measured | 0 |" in markdown
    assert "not measured" in (tmp_path / "report.html").read_text()
    assert built["learning_gain"] == "not measured" and built["deployment"] == "none"
