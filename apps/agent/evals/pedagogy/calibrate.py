#!/usr/bin/env python3
"""Calibrates the examples judge (meaning.py) on labelled turns of earlier runs,
and on hand-written ones, before its verdicts count. No calls without --live.

Every turn is labelled. The gate, on each of two runs: every turn marked must
is right; at most one miss among the turns whose examples change the meaning
(an unclear verdict is a miss); at most one false alarm among the turns that
keep it or have none; and no judge failure. A turn whose words allow both
readings is listed, not scored. The judge takes no sampling parameters, so a
single run is one draw: both must pass.

These turns are development data. The judge's prompt was written with them at
hand, so a pass shows that it fits them, not that it generalizes.
"""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

import meaning
from budget import PRICES, Budget
from cases import digest

HERE = Path(__file__).resolve().parent
FIXTURES = HERE / "fixtures/examples-calibration.json"
EXPECTED = ("changes", "keeps", "none", "ambiguous")
# A miss or a false alarm allowed among the turns not marked must.
MISSES, FALSE_ALARMS = 1, 1
# Runs of the whole set, each of which must pass.
RUNS = 2


def load(path=FIXTURES):
    return json.loads(path.read_text())["sessions"]


def outcome(expect, verdicts):
    """What the judge's verdicts on one turn's examples amount to.

    A turn whose examples change the meaning is a hit when one of them is
    judged "changes". A turn that keeps it is right when one is judged
    "keeps" and none "changes"; one with no example is right without a
    "changes". A "changes" there is a false alarm. An ambiguous turn is not
    scored.
    """
    if expect == "ambiguous":
        return "not_scored"
    if expect == "changes":
        return "hit" if "changes" in verdicts else "miss"
    if "changes" in verdicts:
        return "false_alarm"
    if expect == "keeps" and "keeps" not in verdicts:
        return "unconfirmed"
    return "right"


def outcomes(sessions, judged):
    """Each labelled turn with what the judge said of it: ``judged`` maps a
    session's id to the judge's verdict on it (``meaning.parse``)."""
    found = []
    for session in sessions:
        verdict = judged[session["id"]]
        for label in session["labels"]:
            verdicts = [
                example["verdict"]
                for example in verdict["examples"]
                if example["turn"] == label["turn"]
            ]
            failed = verdict["status"] != "ok"
            found.append(
                dict(
                    session=session["id"],
                    turn=label["turn"],
                    expect=label["expect"],
                    must=label["must"],
                    verdicts=verdicts,
                    outcome="judge_failure" if failed else outcome(label["expect"], verdicts),
                )
            )
    return found


def gate(found, judged):
    """Whether the judge's verdicts may count, and why not."""
    changes = [turn for turn in found if turn["expect"] == "changes"]
    others = [turn for turn in found if turn["expect"] in ("keeps", "none")]
    misses = sum(turn["outcome"] != "hit" for turn in changes)
    alarms = sum(turn["outcome"] == "false_alarm" for turn in others)
    failures = sorted({v["status"] for v in judged.values() if v["status"] != "ok"})
    wrong = [
        f"{turn['session']} turn {turn['turn']}"
        for turn in found
        if turn["must"] and turn["outcome"] not in ("hit", "right")
    ]
    reasons = []
    if wrong:
        reasons.append(f"must turns not right: {', '.join(wrong)}")
    if misses > MISSES:
        reasons.append(f"{misses} misses among changed turns (at most {MISSES})")
    if alarms > FALSE_ALARMS:
        reasons.append(f"{alarms} false alarms (at most {FALSE_ALARMS})")
    if failures:
        reasons.append(f"judge failures: {', '.join(failures)}")
    return dict(
        passed=not reasons,
        reasons=reasons,
        recall=(len(changes) - misses) / len(changes) if changes else None,
        specificity=(len(others) - alarms) / len(others) if others else None,
        misses=misses,
        false_alarms=alarms,
        unconfirmed=sum(turn["outcome"] == "unconfirmed" for turn in others),
    )


def overall(gates):
    """Whether the judge's verdicts may count: every run passed."""
    return dict(passed=len(gates) == RUNS and all(each["passed"] for each in gates), runs=gates)


def hashes(sessions):
    return dict(
        prompt_sha256=digest(meaning.PROMPT),
        schema_sha256=digest(meaning.SCHEMA),
        fixtures_sha256=digest(sessions),
        model=meaning.MODEL,
        runs=RUNS,
    )


def bound(sessions):
    """The most the calls of every run can reserve, as the metered transport
    reserves it: one token per byte of the request plus headroom at the
    highest input rate, and every output token."""
    rates = PRICES[meaning.MODEL]
    total = 0.0
    for session in sessions:
        body = meaning.request(session["exercise"], session["exact_answer"], session["turns"])
        size = len(json.dumps(body, ensure_ascii=False).encode())
        total += ((size + 8192) * rates[4] + meaning.MAX_TOKENS * rates[1]) / 1_000_000
    return total * RUNS


def preview(sessions):
    labels = [label for session in sessions for label in session["labels"]]
    return dict(
        sessions=len(sessions),
        hand_written=sum(bool(session.get("synthetic")) for session in sessions),
        calls=len(sessions) * RUNS,
        turns=len(labels),
        **{expect: sum(label["expect"] == expect for label in labels) for expect in EXPECTED},
        must=sum(label["must"] for label in labels),
        reservation_bound_usd=round(bound(sessions), 6),
        **hashes(sessions),
    )


async def judge_all(sessions, budget, concurrency, run):
    from evaluate import client

    sem = asyncio.Semaphore(concurrency)

    async def one(session):
        async with sem:
            try:
                async with client(budget, f"calibration:{run}:{session['id']}") as api:
                    found = await meaning.judge(
                        api, session["exercise"], session["exact_answer"], session["turns"]
                    )
            except Exception as error:
                found = dict(
                    model=meaning.MODEL,
                    status="error",
                    error=type(error).__name__,
                    examples=[],
                    changed=None,
                    unclear=0,
                )
            return session["id"], found

    return dict(await asyncio.gather(*(one(session) for session in sessions)))


async def main(args):
    sessions = load(Path(args.fixtures))
    print(json.dumps(preview(sessions), indent=2), flush=True)
    if not args.live:
        return 0
    if not 1 <= args.concurrency <= 4:
        raise ValueError("concurrency 1..4 only")
    output = Path(args.output)
    result_path = output / "calibration.json"
    if result_path.exists():
        # Calibrated already with these hashes: its result stands, nothing is paid again.
        saved = json.loads(result_path.read_text())
        if saved["hashes"] != hashes(sessions):
            raise ValueError("calibration.json was made with another prompt, schema or fixtures")
        print(json.dumps(saved["gate"], indent=2), flush=True)
        return 0 if saved["gate"]["passed"] else 1
    if args.credentials:
        credentials = Path(args.credentials)
        if credentials.stat().st_mode & 0o077:
            raise ValueError("credential file must be private (0600)")
        key = json.loads(credentials.read_text()).get("ANTHROPIC_API_KEY")
        if key:
            os.environ["ANTHROPIC_API_KEY"] = key
    if not os.environ.get("ANTHROPIC_API_KEY"):
        raise ValueError("ANTHROPIC_API_KEY is required")
    output.mkdir(parents=True, exist_ok=True)
    budget = Budget(output / "budget.jsonl", args.budget)
    runs = []
    try:
        for run in range(RUNS):
            judged = await judge_all(sessions, budget, args.concurrency, run)
            found = outcomes(sessions, judged)
            runs.append(dict(gate=gate(found, judged), turns=found, judged=judged))
    finally:
        (output / "cost.json").write_text(json.dumps(budget.summary(), indent=2) + "\n")
        budget.close()
    result = dict(
        hashes=hashes(sessions),
        gate=overall([run["gate"] for run in runs]),
        runs=runs,
        budget=json.loads((output / "cost.json").read_text()),
    )
    result_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps(result["gate"], indent=2), flush=True)
    return 0 if result["gate"]["passed"] else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--credentials", help="private JSON file; never a key on the command line")
    parser.add_argument("--output", default="/tmp/aule-pedagogy-eval")
    parser.add_argument("--budget", type=float, default=20)
    parser.add_argument("--concurrency", type=int, default=4)
    parser.add_argument("--fixtures", default=str(FIXTURES))
    sys.exit(asyncio.run(main(parser.parse_args())))
