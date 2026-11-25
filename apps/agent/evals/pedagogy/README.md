# Synthetic pedagogy experiment

A bounded experiment against Aule's actual conversational `Tutor`, its tools and
both safety gates. It creates no accounts, rooms, child records or production
sessions. Every student utterance, age and answer is synthetic. Each turn is
typed through the tutor's own path for typed messages (`Tutor.typed`): both
input gates, then the answer checked in code, then the model.

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
steps per turn (three in the replay, as in production), bounded output and
timeouts keep the run finite.

Nothing here deploys a candidate, schedules recurring paid work or sends email.
CI runs only offline tests (`uv run pytest` collects this folder, and the
checker's `cargo test`). No live calls happen without `--live`.

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

### Replay and the examples judge

`--split replay` runs the last validation run's 10 cases (`cases.REPLAY`) and the
fixed regression cases (`cases.regressions()`, kept apart from the 100 so their
digest does not change), 17 sessions:

- the two explicit-comparison cases;
- `analogy-es` (13 + 3 × 2) and `analogy-en` (16 + 3 × 2), which ask for a story
  with money or sweets, for exercises whose stories spent money in the
  development run;
- `analogy-pizza-es` (1/3 + 1/4), which asks for pizza, where a story once ate
  it;
- `substep-es` (19 + 3 × 2), whose second turn, "Me da 6.", answers a smaller
  step, 3 × 2, and is not a wrong try at the exercise;
- `brings-exercise-es` (28 + 3 × 2), where nothing is open before the student
  brings the exercise and an answer, and the tutor's context does not name it.

No case is the example the tutor's instructions give (18 + 4 × 5), so a tutor
that repeats it does not pass a case for it. It uses arm `replay` and
production's `max_tool_steps` (3); the 100-case benchmark keeps 4. The sessions
land in the report's groups by split: `development/replay`, `holdout/replay`
and `regression/replay`.

The last validation run (2026-11-25) had two examples that changed the
exercise's meaning, and the first judge passed both: math-071 turn 2, 25 soles
in the pocket and 3 candies bought at 2 soles each for 25 + 3 × 2, and math-000
turn 2, half a chocolate bar eaten and "how much is left?" for 1/2 + 1/3.

Every session also goes to a second judge, the examples judge (`meaning.py`,
`claude-haiku-5-5`, not the model under test). It reads only the tutor's
visible lines, lists every example or story first (its turn, an exact quote,
what it stands for, what its question computes, what the whole story computes
with its setup included, each number's role) and then rules: `keeps`,
`changes` or `unclear`. It judges the whole story: a child who starts with an
amount and then buys, spends, eats or gives away the other part has turned an
addition into a subtraction, even when the question asks only for that part.
Its JSON is enforced by the API, thinking is off, and each quote must be found
in the turn it names; an answer cut short, refused, malformed or with a quote
not found is a judge failure. `unclear` examples are listed for review and do
not fail a session.

Its verdicts count only after calibration (`fixtures/examples-calibration.json`)
on every turn of 27 sessions of two earlier runs and of 9 hand-written ones,
99 turns labelled by hand: 20 whose examples change the meaning, 33 that keep
it, 44 with no example and 2 ambiguous, listed and not scored. The
hand-written turns bring what the runs did not show: a division told as taking
a part, the dividend and divisor swapped, the grouping changed, a product told
as adding one group, a story that acts out adding across; and, keeping the
meaning, a worked example with other numbers, buying that adds up, a number
line, two pieces compared. The judge takes no sampling parameters, so one run
is one draw: `calibrate.py --live` judges the set twice, and both runs must
pass: every must turn right (the candy story of math-071 must fail, the good
story of the same exercise must pass), at most one miss among the changed
turns, at most one false alarm among the others, first and last turns
included, no judge failure. It previews by default, calls only with `--live`,
and pays once per output folder.

This is development data. The judge's prompt was written with these runs at
hand, and the last run's math-071 turn 2 is both a must turn and a replay case:
a pass shows that the judge fits these turns, not that it generalizes. Read the
flagged and the unflagged examples of a replay by hand before acting on it.

### Continuing a ledger

A new output folder is a new experiment, with its own authorization. To go on
with an authorized one instead, copy its journal, check it, and record that it
was continued, then run each step on the copy, one at a time:

```sh
mkdir -p "$OUT" && cp -p "$PREV/budget.jsonl" "$OUT/budget.jsonl"
shasum -a 256 "$OUT/budget.jsonl"   # must print the hash recorded for $PREV
printf '%s\n' '{"previous_journal_sha256": "<that hash>", "previous_accounted_usd": <its total>, "shared_total_cap_usd": 20, "previous_requests": <its calls>}' > "$OUT/budget-continuation.json"
uv run python evals/pedagogy/calibrate.py --output "$OUT"
uv run python evals/pedagogy/calibrate.py --live --credentials "$KEYS" --output "$OUT"
uv run python evals/pedagogy/evaluate.py --split replay --output "$OUT"
uv run python evals/pedagogy/evaluate.py --split replay --live --credentials "$KEYS" --concurrency 4 --output "$OUT"
uv run python evals/pedagogy/report.py "$OUT"
```

`Budget` refuses a journal whose cap or prices differ, and anything past USD 20
in all. Stop if calibration exits non-zero. `cost.json` is the ledger's total
since its first row: what one step cost is the new total minus the one before.

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
  hints, and, as a second judge, whether each example keeps the exercise's
  meaning. Same-family bias remains. Scores are **automated flags**, with evidence
  saved for review, not ground-truth judgments.
- A session passes when the tutor asserted no wrong arithmetic, praised no wrong
  answer, did not give the answer away, adapted after the request for something
  easier, gave a usable next step, used no example or story that changes the
  exercise's meaning, and every turn that code reads as an answer in digits or a
  request for help, while an exercise was open, was checked in code and
  answered by the checker. Answers said in words, questions and other turns are
  left to the model and not required. When the student brings the exercise,
  their first turn must be checked once it is posed. These are automated flags,
  from a Haiku judge and from the harness, with quotes saved for review;
  same-family bias remains. A passing session shows behaviour on scripted text
  turns. It is not evidence that a child learned anything, and it does not test
  voice, speech recognition, the screen, the camera or the device.
- The report counts, per set: turns with an exercise open, checked in code, by
  the model, left to it, checks the checker could not answer ("Not checked",
  never counted as checked), required but unchecked (must be 0), checked twice
  for one exercise (must be 0), checked right after a pose, and turns that
  failed before they were recorded (must be 0). A session saved before the
  examples judge and these checks is "not measured", never passed.
- The primary result requires all criteria and no execution failures.
  Repeated comparisons are paired and bootstrap resampling keeps case repetitions
  together. A candidate with more critical flags cannot qualify as improved.
- The actual arithmetic parser also flags numeric answer mentions. This is only
  a screening signal (articles like “un” can parse as 1), never the leak verdict.
- Latency includes local operator network and a buffered text transport. It is
  neither production-server latency nor time to first spoken audio.

## Offline checks

```sh
uv run pytest evals/pedagogy
cargo test --locked --manifest-path evals/pedagogy/checker/Cargo.toml
```

They cover the ledger, the cases and their digest, a turn typed through a real
`AgentSession` with a model answering from a script, the report's figures, the
examples judge's request and parsing, and its calibration's gate, with no call.

The journal records actual token categories and conservative unsettled reserves.
Prices were checked on 2026-11-25 UTC against
[Anthropic](https://platform.claude.com/docs/en/about-claude/pricing) and
[TypeSafe](https://help.typesafe.ai/articles/5187202169-how-much-does-jev-cost).
Recheck pricing before a new experiment; changing it during a run requires a new
explicitly authorized experiment, not a reset of the old ledger.
