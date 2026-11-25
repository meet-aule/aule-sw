#!/usr/bin/env python3
"""Read saved synthetic results only; never makes API calls."""

import argparse
import html
import json
import random
import statistics
from collections import Counter, defaultdict
from pathlib import Path

BAD = ("math_error", "endorsed_wrong", "premature_answer")
GOOD = ("adapted", "useful_next_step")


def passes(row):
    judged = row.get("judge")
    return bool(
        judged
        and not row["errors"]
        and all(not judged[k] for k in BAD)
        and all(judged[k] for k in GOOD)
    )


def metrics(rows):
    judged = [r for r in rows if r.get("judge")]
    turns = [t for r in rows for t in r["turns"]]
    durations = sorted(t["seconds"] for t in turns)
    tools = [t for t in turns if any(e["tool"] == "check_answer" for e in t["tools"])]
    return dict(
        sessions=len(rows),
        judged=len(judged),
        passes=sum(passes(r) for r in rows),
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


def paired(rows):
    by_case = defaultdict(dict)
    for row in rows:
        by_case[(row["id"], row["repetition"])][row["arm"]] = row
    differences = defaultdict(list)
    discordant = Counter()
    for (case, _rep), arms in by_case.items():
        if "baseline" not in arms or "candidate" not in arms:
            continue
        baseline, candidate = passes(arms["baseline"]), passes(arms["candidate"])
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


def build(directory):
    rows = [json.loads(p.read_text()) for p in sorted(directory.glob("math-*.json"))]
    normal = [r for r in rows if r["arm"] in ("baseline", "candidate")]
    holdout = [r for r in normal if r["split"] == "holdout"]
    groups = {
        f"{split}/{arm}": metrics([r for r in normal if r["split"] == split and r["arm"] == arm])
        for split in ("development", "holdout")
        for arm in ("baseline", "candidate")
        if any(r["split"] == split and r["arm"] == arm for r in normal)
    }
    paired_result = paired(holdout)
    baseline, candidate = groups.get("holdout/baseline", {}), groups.get("holdout/candidate", {})
    regressions = [k for k in BAD if candidate.get(k, 0) > baseline.get(k, 0)]
    evidence = []
    for r in normal:
        if not passes(r):
            evidence.append(
                dict(
                    id=r["id"],
                    arm=r["arm"],
                    repetition=r["repetition"],
                    errors=r["errors"],
                    judge=r.get("judge"),
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
        failures=evidence,
    )


def render(report, directory):
    lines = [
        "# Aule synthetic pedagogy experiment",
        "",
        "This evaluates observable conversational tutoring behavior, not whether children learn.",
        "",
        "| Set / arm | Sessions | All criteria pass | Math flags | Wrong praise | "
        "Answer leaks | Adapted | Errors |",
        "|---|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for name, m in report["groups"].items():
        lines.append(
            f"| {name} | {m['sessions']} | {m['passes']} | {m['math_error']} | "
            f"{m['endorsed_wrong']} | {m['premature_answer']} | {m['adapted']} | "
            f"{m['sessions_with_errors']} |"
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
        "- The real Tutor, tool schemas, input/output gates and production arithmetic module run. "
        "The checker guidance/state adapter is local; platform mastery, lesson engine, supervisor, "
        "database, voice, screen, camera and IoT hardware are not exercised.",
        "- Correct final answers come from a script and cannot be interpreted as learning gains.",
        "- The held-out set shares templates with development. It tests numerical variations, "
        "not unseen curricula or representative students.",
        "- A Haiku judge scores Sonnet replies. Same-family bias remains; its labels are automated "
        "flags, not verified educational outcomes. Calibration controls and quoted "
        "evidence are retained.",
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
        "## Flagged sessions",
        "",
    ]
    for failure in report["failures"]:
        lines += [
            f"### {failure['id']} / {failure['arm']} / run {failure['repetition']}",
            "",
            f"Errors: `{json.dumps(failure['errors'])}`.",
            json.dumps(failure["judge"], ensure_ascii=False),
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
            f"errors</p></article>"
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
