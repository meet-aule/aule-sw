#!/usr/bin/env python3
"""One bounded improvement attempt; no deployment, recurring spend or real users."""

import argparse
import asyncio
import json
import os
import random
from pathlib import Path

from budget import Budget
from cases import cases, digest
from evaluate import JUDGE, JUDGE_MODEL, TUTOR_MODEL, client, judge, run_case, source_hash

PROPOSER = """Suggest one small, general instruction addendum for a school math tutor.
You are given development transcripts and rubric outcomes, never holdout cases.
Only improve the tutor's pedagogy and use of pose_exercise/check_answer.
Do not change safety filters, evaluator, math checker, tools, budgets or models.
Do not refer to tests, scores, evaluation, case IDs, fixed student scripts or gold answers.
Do not include specific problem answers or problem numbers from the examples.
Keep it under 180 words. Write English instructions that apply to both Spanish and English
lessons. Preserve a friendly tone, short replies and the student's opportunity to reason.
Return ONLY the instruction addendum, no markdown or commentary.
"""


async def controls(budget):
    case = dict(expression="1/2 + 1/3", answer="5/6", wrong="2/5")
    fixtures = [
        (
            "wrong_praise",
            [
                "Sí, dos quintos es correcto: suma arriba y abajo.",
                "Hazlo igual otra vez.",
                "Correcto, dos quintos.",
            ],
            {"math_error": True, "endorsed_wrong": True, "adapted": False},
        ),
        (
            "answer_leak",
            ["La respuesta es cinco sextos.", "Ya te dije: cinco sextos.", "Cinco sextos."],
            {"premature_answer": True, "adapted": False},
        ),
        (
            "useful_hint",
            [
                "Las partes tienen distinto tamaño. ¿Podemos dibujar una misma barra?",
                "Probemos algo más fácil: dibuja dos mitades de una pizza. "
                "Si juntas las dos, ¿cuánta pizza tienes?",
                "Volvamos al dibujo. ¿Cómo podrías dividir cada mitad en tres partes?",
            ],
            {
                "math_error": False,
                "endorsed_wrong": False,
                "premature_answer": False,
                "adapted": True,
                "useful_next_step": True,
            },
        ),
        ("empty", ["", "", ""], {"adapted": False, "useful_next_step": False}),
    ]
    result = []
    student = [
        "Sumé un medio y un tercio y me dio dos quintos.",
        "No entiendo. Explícalo de otra manera.",
        "Solo dime la respuesta.",
    ]
    for name, replies, expected in fixtures:
        turns = [
            dict(student=s, assistant=[a] if a else [])
            for s, a in zip(student, replies, strict=True)
        ]
        observed = await judge(budget, "judge-control:" + name, case, turns)
        result.append(
            dict(
                id=name,
                expected=expected,
                observed=observed,
                passed=all(observed[k] == v for k, v in expected.items()),
            )
        )
    return result


async def main(args):
    dataset = cases()
    development = [c for c in dataset if c["split"] == "development"]
    holdout = [c for c in dataset if c["split"] == "holdout"]
    print(
        json.dumps(
            dict(
                development=len(development),
                holdout=len(holdout),
                paired_sessions=2 * len(holdout) * args.repetitions,
                budget_usd=20,
                live=args.live,
            )
        ),
        flush=True,
    )
    if not args.live:
        return
    if not 1 <= args.repetitions <= 3 or not 1 <= args.concurrency <= 4:
        raise ValueError("invalid repetitions or concurrency")
    output = Path(args.output)
    credential_path = Path(args.credentials)
    if credential_path.stat().st_mode & 0o077:
        raise ValueError("credentials must be private (0600)")
    for key, value in json.loads(credential_path.read_text()).items():
        if key in ("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "TYPESAFE_API_KEY"):
            os.environ[key] = value
    rows = [json.loads((output / f"{c['id']}-baseline-0.json").read_text()) for c in development]
    if any(r.get("source_sha256") != source_hash() for r in rows):
        raise ValueError("development results do not match the current evaluated source")
    budget = Budget(output / "budget.jsonl", 20)
    try:
        control_path = output / "judge-controls.json"
        if not control_path.exists():
            control_path.write_text(
                json.dumps(await controls(budget), ensure_ascii=False, indent=2)
            )
        control_results = json.loads(control_path.read_text())
        if not all(r["passed"] for r in control_results):
            raise ValueError("judge failed calibration controls; no candidate comparison")
        candidate_path = output / "candidate.txt"
        proposal_path = output / "proposal.json"
        frozen = dict(
            development_sha256=digest(rows),
            dataset_sha256=digest(dataset),
            source_sha256=source_hash(),
            rubric_sha256=digest(JUDGE),
        )
        if candidate_path.exists():
            proposal = json.loads(proposal_path.read_text())
            if any(proposal[k] != v for k, v in frozen.items()):
                raise ValueError("candidate cannot be regenerated after seeing holdout results")
            candidate = candidate_path.read_text()
            if digest(candidate) != proposal["candidate_sha256"]:
                raise ValueError("candidate changed after freezing")
        else:
            # Choose failures first, then deterministic examples. Tool omissions
            # are visible even when the semantic rubric is at its ceiling.
            ranked = sorted(
                rows,
                key=lambda r: (
                    not bool(r["errors"]),
                    not any(
                        r.get("judge", {}).get(k)
                        for k in ("math_error", "endorsed_wrong", "premature_answer")
                    ),
                    sum(
                        any(t["tool"] == "check_answer" for t in turn["tools"])
                        for turn in r["turns"]
                    ),
                    r["id"],
                ),
            )
            evidence = [
                dict(id=r["id"], turns=r["turns"], judge=r.get("judge"), errors=r["errors"])
                for r in ranked[:8]
            ]
            async with client(budget, "candidate-proposal") as api:
                response = await api.messages.create(
                    model=TUTOR_MODEL,
                    max_tokens=1500,
                    system=PROPOSER,
                    messages=[
                        {"role": "user", "content": json.dumps(evidence, ensure_ascii=False)}
                    ],
                )
            candidate = "\n".join(b.text for b in response.content if b.type == "text").strip()
            if not candidate or len(candidate.split()) > 180:
                raise ValueError("candidate is empty or too long; no automatic retry")
            candidate_path.write_text(candidate)
            proposal = dict(
                **frozen,
                candidate_sha256=digest(candidate),
                proposer_model=TUTOR_MODEL,
                judge_model=JUDGE_MODEL,
                examples=[r["id"] for r in ranked[:8]],
                attempts=1,
            )
            proposal_path.write_text(json.dumps(proposal, indent=2))
        print(
            json.dumps(dict(candidate_frozen=digest(candidate), budget=budget.summary())),
            flush=True,
        )
        jobs = [
            (case, arm, rep)
            for case in holdout
            for rep in range(args.repetitions)
            for arm in ("baseline", "candidate")
        ]
        random.Random(20261125).shuffle(jobs)  # Interleave arms to reduce time-of-day confounding.
        sem = asyncio.Semaphore(args.concurrency)

        async def bounded(case, arm, rep):
            async with sem:
                return await run_case(
                    budget, case, arm, candidate if arm == "candidate" else "", rep, output
                )

        await asyncio.gather(*(bounded(*job) for job in jobs))
    finally:
        (output / "cost.json").write_text(json.dumps(budget.summary(), indent=2))
        budget.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--output", required=True)
    parser.add_argument("--credentials")
    parser.add_argument("--repetitions", type=int, default=2)
    parser.add_argument("--concurrency", type=int, default=4)
    asyncio.run(main(parser.parse_args()))
