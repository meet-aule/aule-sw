# Synthetic pedagogy experiment

A bounded experiment against Aule's actual conversational `Tutor`, its tools and
both safety gates. It creates no accounts, rooms, child records or production
sessions. Every student utterance, age and answer is synthetic.

This measures tutoring behavior. A scripted student's correct final answer is
**not evidence that a child learned**. It does not validate the platform's lesson
engine, mastery estimates, supervisor, persistence, voice, screen, camera or IoT.
The arithmetic adapter compiles the production `exercise.rs`; its local state and
guidance deliberately avoid the platform/database. Treat that boundary as part of
the result, not as an end-to-end product claim.

## One experiment, at most USD 20

All paid requests share one append-only, locked budget journal, including tutor,
semantic judge, candidate proposer, safety second reader and TypeSafe. The ledger
reserves a conservative amount **before** each call, and settles from returned
usage. Unknown usage, timeouts and cancellations retain their full reservation.
A restart resumes the same ledger; it cannot increase the cap. Unknown models or
oversized requests are rejected before sending. A separate output directory is a
separate experiment and requires its own spend authorization.

The cap is based on public USD list prices, excluding taxes. Provider invoices
and credits are not read. Moderation is free; no STT or TTS is called. Network
failures count as failures, never successful teaching. Normal and failed requests
remain in the reports. Four parallel sessions, three turns per session, four tool
steps per turn, bounded output and timeouts keep the run finite.

Nothing here deploys a candidate, schedules recurring paid work or sends email.
CI runs only offline budget/checker tests. No live calls happen without `--live`.

## Run

Use the agent's locked environment (`uv sync --locked`). Provider credentials
for `evaluate.py` come from the environment: `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`TYPESAFE_API_KEY`. The autonomous phase uses `--credentials`; `evaluate.py` also accepts it.
`--credentials /private/file.json` reads exactly
those three keys from a file with mode 0600. Never put keys in commands, reports
or Git. Keep output outside the repository until it has been reviewed.

From the repository root, build the small, database-free checker:

```sh
cargo build --locked --manifest-path apps/agent/evals/pedagogy/checker/Cargo.toml
```

From `apps/agent`, preview the manifest without calling providers:

```sh
uv run python evals/pedagogy/evaluate.py --split development --limit 100
```

Run the development set, then one autonomous proposal and a paired comparison.
Use **the same output directory and ledger for every phase**, including smoke runs:

```sh
uv run python evals/pedagogy/evaluate.py --live --split development --limit 100 \
  --concurrency 4 --output /private/aule-experiment
uv run python evals/pedagogy/autonomous.py --live --repetitions 2 \
  --credentials /private/provider-keys.json --output /private/aule-experiment
uv run python evals/pedagogy/report.py /private/aule-experiment
```

The autonomous step requires the completed development results. It tests its judge
on four known controls, proposes **one** short instruction addendum using only
development examples, freezes its hash, and interleaves baseline/candidate runs
on the reserved set. It cannot edit the evaluator, tools or filters. A changed
candidate, source or dataset cannot silently reuse old results. Failed results
are retained; rerunning a phase does not discard them to improve the score.

`report.html` is a self-contained, phone-readable report with no external scripts
or analytics. `report.md` and `summary.json` contain the same key results.

## Interpretation

- 100 fixed cases: three mathematical skills, Spanish/English, ages 10–12.
  The split is stratified by skill, language and answer-pressure vs correct-answer
  ending. Held-out cases share templates with development; this is a regression
  benchmark, not independent evidence of broad educational efficacy.
- Three scripted turns: a known misconception, an explicit request for a simpler
  explanation, and either answer pressure or a correct answer supplied by script.
- `claude-sonnet-5-5` is the tutor and proposer; `claude-haiku-5-5` judges arithmetic
  claims, praise of wrong answers, premature disclosure, adaptation and actionable
  hints. Same-family bias remains. Scores are **automated flags**, with evidence
  saved for review, not ground-truth judgments.
- The primary result requires all five criteria and no execution failures.
  Repeated comparisons are paired and bootstrap resampling keeps case repetitions
  together. A candidate with more critical flags cannot qualify as improved.
- The actual arithmetic parser also flags numeric answer mentions. This is only
  a screening signal (articles like “un” can parse as 1), never the leak verdict.
- Latency includes local operator network and a buffered text transport. It is
  neither production-server latency nor time to first spoken audio.

## Offline checks

```sh
uv run pytest evals/pedagogy/test_budget.py
cargo test --locked --manifest-path evals/pedagogy/checker/Cargo.toml
```

The journal records actual token categories and conservative unsettled reserves.
Prices were checked on 2026-11-25 UTC against
[Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) and
[TypeSafe](https://help.typesafe.ai/articles/5187202169-how-much-does-jev-cost).
Recheck pricing before a new experiment; changing it during a run requires a new
explicitly authorized experiment, not a reset of the old ledger.
