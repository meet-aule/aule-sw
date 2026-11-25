#!/usr/bin/env python3
"""Read saved synthetic results only; never makes API calls."""

import argparse
import html
import json
import random
import statistics
from collections import Counter, defaultdict
from pathlib import Path

import calibrate

BAD = ("math_error", "endorsed_wrong", "premature_answer")
GOOD = ("adapted", "useful_next_step")
# How the tutor starts the call id of a check it made in code (tutor.CHECKED_IN_CODE).
CHECKED_IN_CODE = "aule_check_"
CHECK_FIGURES = (
    "open_turns",
    "code_checked",
    "model_checked",
    "left_to_model",
    "checker_failures",
    "required_unchecked",
    "double_checks",
    "pose_checked",
    "unrecorded",
)


def legacy(row):
    """The five criteria of the first judge, and no execution error."""
    judged = row.get("judge")
    return bool(
        judged
        and not row["errors"]
        and all(not judged[k] for k in BAD)
        and all(judged[k] for k in GOOD)
    )


def checks(row):
    """How the session's answers were checked, or None for a session saved
    before turns recorded their checks: that is not measured, never passed.

    What code is to check is required, nothing more: a turn the input
    gates let through, with an exercise open before it, that code read as
    an answer in digits or a request for help must carry a check made in
    code that the checker answered. Answers in words, questions and the
    rest are left to the model and not required. When the student brings
    the exercise (nothing is open before their first turn), that turn must
    be checked once it is posed, after the pose or by the model. A check
    the checker could not answer ("Not checked") is counted apart and never
    as a check; a turn with no record (it failed or timed out first) is
    counted too. No turn may call the checker twice for one exercise.
    """
    if not any("check" in turn for turn in row["turns"]):
        return None
    figures = dict.fromkeys(CHECK_FIGURES, 0)
    for turn in row["turns"]:
        check = turn.get("check")
        if check is None:
            figures["unrecorded"] += 1
            continue
        failed = bool(check.get("failed"))
        figures["checker_failures"] += failed
        if turn.get("input_allowed") and check["open_before"]:
            figures["open_turns"] += 1
            figures["code_checked"] += "code" in check["by"] and not failed
            figures["model_checked"] += "model" in check["by"] and not failed
            figures["left_to_model"] += check["kind"] == "left"
            needed = check["kind"] in ("help", "answer")
            figures["required_unchecked"] += needed and (failed or not checked_in_code(turn))
        figures["pose_checked"] += "pose" in check["by"] and not failed
        figures["double_checks"] += checked_twice(turn)
    first = row["turns"][0].get("check")
    if row.get("posed") is False and first is not None:
        figures["required_unchecked"] += not first["by"] or bool(first.get("failed"))
    figures["complete"] = not (
        figures["required_unchecked"] or figures["double_checks"] or figures["unrecorded"]
    )
    return figures


def checked_in_code(turn):
    return any(
        event.get("type") == "function_call"
        and event.get("name") == "check_answer"
        and str(event.get("call_id", "")).startswith(CHECKED_IN_CODE)
        for event in turn.get("function_events", [])
    )


def checked_twice(turn):
    """Whether the checker was called more than once for one exercise."""
    exercises = [e.get("exercise") for e in turn["tools"] if e["tool"] == "check_answer"]
    return len(exercises) != len(set(exercises))


def examples(row):
    """The examples judge's verdict on the session (``meaning``), or None for a
    session from before it: that is not measured, never passed."""
    return row.get("examples")


def calibration(directory):
    """How the examples judge's calibration stands in this folder: "passed",
    "failed", "missing", or "stale" when it was made with another prompt,
    schema or set of labelled turns. Its verdicts count only once it passed."""
    path = directory / "calibration.json"
    if not path.exists():
        return "missing"
    saved = json.loads(path.read_text())
    if saved.get("hashes") != calibrate.hashes(calibrate.load()):
        return "stale"
    return "passed" if saved["gate"]["passed"] else "failed"


def passes(row, calibrated):
    checked, judged = checks(row), examples(row)
    return bool(
        legacy(row)
        and checked is not None
        and checked["complete"]
        and calibrated
        and judged is not None
        and judged["status"] == "ok"
        and not judged["changed"]
    )


def judged_examples(rows, verdict):
    """Every example given this verdict, where it was said and why."""
    return [
        dict(id=r["id"], arm=r["arm"], repetition=r["repetition"], **example)
        for r in rows
        if (examples(r) or {}).get("status") == "ok"
        for example in examples(r)["examples"]
        if example["verdict"] == verdict
    ]


def metrics(rows, calibrated):
    judged = [r for r in rows if r.get("judge")]
    turns = [t for r in rows for t in r["turns"]]
    durations = sorted(t["seconds"] for t in turns)
    tools = [t for t in turns if any(e["tool"] == "check_answer" for e in t["tools"])]
    checked = [c for c in (checks(r) for r in rows) if c is not None]
    measured = [examples(r) for r in rows if examples(r) is not None]
    return dict(
        sessions=len(rows),
        judged=len(judged),
        passes=sum(passes(r, calibrated) for r in rows),
        legacy_passes=sum(legacy(r) for r in rows),
        checks_measured=len(checked),
        checks_complete=sum(c["complete"] for c in checked),
        **{key: sum(c[key] for c in checked) for key in CHECK_FIGURES},
        examples_measured=len(measured),
        examples_judge_failures=sum(e["status"] != "ok" for e in measured),
        sessions_with_changed_examples=sum(e["status"] == "ok" and e["changed"] for e in measured),
        changed_examples=sum(
            x["verdict"] == "changes" for e in measured for x in e.get("examples", [])
        ),
        unclear_examples=sum(e.get("unclear", 0) for e in measured),
        sessions_with_errors=sum(bool(r["errors"]) for r in rows),
        conversation_failures=sum(
            not r["turns"] or any(t["error"] for t in r["turns"]) for r in rows
        ),
        judge_failures=sum(bool(r["turns"]) and not r.get("judge") for r in rows),
        turns=len(turns),
        turns_with_check_answer=len(tools),
        **{key: sum(bool(r["judge"][key]) for r in judged) for key in BAD + GOOD},
        latency_median_seconds=statistics.median(durations) if durations else None,
        latency_p95_seconds=durations[min(len(durations) - 1, int(len(durations) * 0.95))]
        if durations
        else None,
    )


def paired(rows, calibrated):
    by_case = defaultdict(dict)
    for row in rows:
        by_case[(row["id"], row["repetition"])][row["arm"]] = row
    differences = defaultdict(list)
    discordant = Counter()
    for (case, _rep), arms in by_case.items():
        if "baseline" not in arms or "candidate" not in arms:
            continue
        baseline = passes(arms["baseline"], calibrated)
        candidate = passes(arms["candidate"], calibrated)
        differences[case].append(int(candidate) - int(baseline))
        if baseline != candidate:
            discordant["improved" if candidate else "regressed"] += 1
    # Resample case IDs, keeping repeated runs together. These are synthetic
    # templates, not a representative population sample or a clinical trial.
    values = [statistics.mean(v) for v in differences.values()]
    if not values:
        return {}
    rng = random.Random(20261125)
    draws = sorted(statistics.mean(rng.choices(values, k=len(values))) for _ in range(10000))
    return dict(
        cases=len(values),
        matched_runs=sum(map(len, differences.values())),
        difference_percentage_points=100 * statistics.mean(values),
        bootstrap_95_interval=[100 * draws[250], 100 * draws[9750]],
        discordant_runs=dict(discordant),
    )


def results(directory):
    """Every saved session: a file with turns, whatever its case, split or arm."""
    rows = []
    for path in sorted(directory.glob("*.json")):
        row = json.loads(path.read_text())
        if isinstance(row, dict) and isinstance(row.get("turns"), list) and "arm" in row:
            rows.append(row)
    return rows


def build(directory):
    rows = results(directory)
    calibrated = calibration(directory)
    normal = [r for r in rows if r["arm"] in ("baseline", "candidate")]
    holdout = [r for r in normal if r["split"] == "holdout"]
    # The benchmark's sets first, as before; any other split or arm after them.
    names = [
        f"{split}/{arm}"
        for split in ("development", "holdout")
        for arm in ("baseline", "candidate")
    ]
    names += sorted({f"{r['split']}/{r['arm']}" for r in rows} - set(names))
    groups = {
        name: metrics(
            [r for r in rows if f"{r['split']}/{r['arm']}" == name], calibrated == "passed"
        )
        for name in names
        if any(f"{r['split']}/{r['arm']}" == name for r in rows)
    }
    paired_result = paired(holdout, calibrated == "passed")
    baseline, candidate = groups.get("holdout/baseline", {}), groups.get("holdout/candidate", {})
    regressions = [k for k in BAD if candidate.get(k, 0) > baseline.get(k, 0)]
    evidence = []
    for r in rows:
        if not passes(r, calibrated == "passed"):
            evidence.append(
                dict(
                    id=r["id"],
                    arm=r["arm"],
                    repetition=r["repetition"],
                    errors=r["errors"],
                    judge=r.get("judge"),
                    checks=checks(r),
                    examples=examples(r),
                    turns=r["turns"],
                )
            )
    complete = bool(
        baseline
        and candidate
        and baseline["sessions"] == candidate["sessions"]
        and baseline["judged"] == baseline["sessions"]
        and candidate["judged"] == candidate["sessions"]
    )
    plan_path = directory / "comparison-plan.json"
    if plan_path.exists():
        plan = json.loads(plan_path.read_text())
        complete = complete and len(holdout) == plan["planned_heldout_sessions"]
        complete = complete and paired_result.get("matched_runs", 0) * 2 == len(holdout)
    improvement = bool(
        complete
        and not regressions
        and paired_result
        and paired_result["bootstrap_95_interval"][0] > 0
    )
    return dict(
        groups=groups,
        paired=paired_result,
        cost=json.loads((directory / "cost.json").read_text()),
        critical_regressions=regressions,
        comparison_complete=complete,
        improvement_supported_on_this_benchmark=improvement,
        deployment="none",
        learning_gain="not measured",
        examples_calibration=calibrated,
        changed_examples=judged_examples(rows, "changes"),
        unclear_examples=judged_examples(rows, "unclear"),
        failures=evidence,
    )


def example_lines(found):
    if not found:
        return ["None."]
    return [
        f"- {x['id']} / {x['arm']} / run {x['repetition']}, turn {x['turn']}: "
        f"«{x['quote']}» — stands for `{x['stands_for']}`, its question computes "
        f"`{x['story_expression']}`, the whole story `{x.get('whole_story', '?')}`. "
        f"{x['reason']}"
        for x in found
    ]


def measured(count, of):
    return f"{count}/{of}" if of else "not measured"


def render(report, directory):
    lines = [
        "# Aule synthetic pedagogy experiment",
        "",
        "This evaluates observable conversational tutoring behavior, not whether children learn.",
        "",
        "| Set / arm | Sessions | All criteria pass | First judge's criteria pass | Math flags | "
        "Wrong praise | Answer leaks | Adapted | Changed examples | Checks complete | Errors |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for name, m in report["groups"].items():
        changed = (
            f"{m['sessions_with_changed_examples']} ({m['examples_judge_failures']} failed)"
            if m["examples_measured"]
            else "not measured"
        )
        lines.append(
            f"| {name} | {m['sessions']} | {m['passes']} | {m['legacy_passes']} | "
            f"{m['math_error']} | {m['endorsed_wrong']} | {m['premature_answer']} | "
            f"{m['adapted']} | {changed} | "
            f"{measured(m['checks_complete'], m['checks_measured'])} | "
            f"{m['sessions_with_errors']} |"
        )
    lines += [
        "",
        "A session passes all criteria only when the first judge's criteria pass, the examples "
        "judge answered and found no example that changes the exercise's meaning, and every "
        "turn that code reads as an answer in digits or a request for help was checked in code "
        "and answered by the checker. A session saved before these were measured is counted as "
        "not measured, never as passed.",
        "",
        f"Calibration of the examples judge in this folder: "
        f"**{report['examples_calibration']}**. Its verdicts count only once it passed; "
        "until then no session passes all criteria.",
        "",
        "## Answer checks",
        "",
        "| Set / arm | Turns with an exercise open | Checked in code | Checked by the model | "
        "Left to the model | Checker could not tell | Required, unchecked | Checked twice | "
        "Checked after a pose | Turns not recorded |",
        "|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for name, m in report["groups"].items():
        if not m["checks_measured"]:
            lines.append(f"| {name} | not measured | | | | | | | | |")
            continue
        lines.append(
            f"| {name} | {m['open_turns']} | {m['code_checked']} | {m['model_checked']} | "
            f"{m['left_to_model']} | {m['checker_failures']} | {m['required_unchecked']} | "
            f"{m['double_checks']} | {m['pose_checked']} | {m['unrecorded']} |"
        )
    cost = report["cost"]
    lines += [
        "",
        f"Usage-based API cost estimate: **USD {cost['usage_based_estimate_usd']:.4f}**.",
        f"Unreconciled request reserves: **USD {cost['unreconciled_upper_bound_usd']:.4f}**.",
        f"Total conservative accounted amount: **USD "
        f"{cost['committed_upper_bound_usd']:.4f} / 20**.",
        "",
        "These are public list-price estimates, not a reconciled provider invoice. "
        "Reservations include cancelled/failed attempts and smoke tests; no tax is included.",
        "",
        f"Paired comparison: `{json.dumps(report['paired'])}`.",
        f"Evidence of improvement on this benchmark: "
        f"**{report['improvement_supported_on_this_benchmark']}**.",
        f"Critical regressions flagged: **{', '.join(report['critical_regressions']) or 'none'}**.",
        "",
        "No candidate was deployed. No recurring paid job was scheduled.",
        "",
        "## Scope and limitations",
        "",
        "- 100 synthetic math cases across fraction addition, fraction division and "
        "operation order; "
        "Spanish and English; synthetic ages 10–12. Three fixed student turns per case.",
        "- A replay (`--split replay`) takes the last validation run's 10 cases and the fixed "
        "regression cases; it checks known failures again and is not a benchmark.",
        "- Turns are typed through the tutor's own path for typed messages: both input gates, "
        "then the answer checked in code, then the model. Speech recognition is not exercised.",
        "- The real Tutor, tool schemas, input/output gates and production arithmetic module run. "
        "The checker guidance/state adapter is local; platform mastery, lesson engine, supervisor, "
        "database, voice, screen, camera and IoT hardware are not exercised.",
        "- Correct final answers come from a script and cannot be interpreted as learning gains.",
        "- The held-out set shares templates with development. It tests numerical variations, "
        "not unseen curricula or representative students.",
        "- A Haiku judge scores Sonnet replies. Same-family bias remains; its labels are automated "
        "flags, not verified educational outcomes. Calibration controls and quoted "
        "evidence are retained.",
        "- A second Haiku judge lists the tutor's examples and stories and whether each keeps "
        "the meaning of what it stands for; its quotes must be found in the turn it names. "
        "Unclear verdicts are listed for review and do not fail a session.",
        "- Repeated runs are clustered by case for the bootstrap interval. There is no claim of "
        "population-level statistical generalization.",
        "- Numeric answer mentions are only screening signals: Spanish parsing can count articles "
        "such as “un” as 1. They are not used as proof of a leaked answer.",
        "- Gate delays include the operator network. They do not establish "
        "production-server latency.",
        "",
        "## Reproducibility",
        "",
        "See the frozen dataset, source and rubric hashes in the manifests; "
        "candidate/proposal files; "
        "individual synthetic transcripts; calibration controls; and the "
        "append-only budget journal.",
        "",
        "Prices checked against [Anthropic "
        "pricing](https://platform.claude.com/docs/en/about-claude/pricing) "
        "and [TypeSafe "
        "pricing](https://help.typesafe.ai/articles/5187202169-how-much-does-jev-cost).",
        "",
        "## Examples that change the meaning",
        "",
        *example_lines(report["changed_examples"]),
        "",
        "## For review (unclear)",
        "",
        *example_lines(report["unclear_examples"]),
        "",
        "## Flagged sessions",
        "",
    ]
    for failure in report["failures"]:
        lines += [
            f"### {failure['id']} / {failure['arm']} / run {failure['repetition']}",
            "",
            f"Errors: `{json.dumps(failure['errors'])}`.",
            json.dumps(failure["judge"], ensure_ascii=False),
            f"Checks: `{json.dumps(failure['checks'])}`.",
            f"Examples: `{json.dumps(failure['examples'], ensure_ascii=False)}`.",
            "",
        ]
    markdown = "\n".join(lines) + "\n"
    (directory / "report.md").write_text(markdown)
    cards = []
    for name, m in report["groups"].items():
        cards.append(
            f"<article><h2>{html.escape(name)}</h2><b>{m['passes']}/{m['sessions']}</b> "
            f"sessions passed all criteria<p>{m['math_error']} math flags · "
            f"{m['premature_answer']} answer leaks · {m['sessions_with_errors']} "
            f"errors · {m['sessions_with_changed_examples']} with an example that changes "
            f"the meaning · checks complete "
            f"{measured(m['checks_complete'], m['checks_measured'])}</p></article>"
        )
    (directory / "report.html").write_text(
        '<!doctype html><html lang="en"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width, initial-scale=1">'
        "<title>Aule pedagogy experiment</title><style>body{font:17px system-ui;max-width:980px;"
        "margin:auto;padding:24px;color:#142b3b;background:#f4f7fb}article{background:white;padding:20px;"
        "margin:16px "
        "0;border-radius:12px}b{font-size:28px}pre{white-space:pre-wrap;overflow-wrap:anywhere;"
        "font:14px/1.6 system-ui}summary{cursor:pointer}</style><h1>Aule: synthetic "
        "tutor evaluation</h1>"
        "<p>Behavioral regression evidence. Learning in children has not been measured.</p>"
        + "".join(cards)
        + f"<p>Conservative cost: <strong>USD {cost['committed_upper_bound_usd']:.2f} "
        f"/ 20</strong></p>"
        + "<details><summary>Full report and limitations</summary><pre>"
        + html.escape(markdown)
        + "</pre></details></html>"
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    report = build(args.directory)
    (args.directory / "summary.json").write_text(json.dumps(report, ensure_ascii=False, indent=2))
    render(report, args.directory)
    print(json.dumps({k: v for k, v in report.items() if k != "failures"}, indent=2))
