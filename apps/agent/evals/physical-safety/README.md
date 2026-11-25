# Physical-safety evaluation

Synthetic conversations replayed against the physical-safety gate (`aule_agent.physical_safety`), to check that the model, the question and the thresholds still give the expected verdicts.

**It calls the real provider (TypeSafe).** A live run costs money and sends the case texts to the provider. It is run by hand, never in CI. The unit tests in `tests/` use fakes and make no calls.

```bash
# Prints what would be run. No calls, no key needed.
uv run python evals/physical-safety/evaluate.py

# Calls the provider. The key is read from stdin, never from an argument.
uv run python evals/physical-safety/evaluate.py --live < key.txt
uv run python evals/physical-safety/evaluate.py --live --cases evals/physical-safety/bilingual-cases.json < key.txt

# The same scenarios, all told one age: --age 12, --grade S1 or --unknown-age.
uv run python evals/physical-safety/evaluate.py --live --cases evals/physical-safety/prospective-cases.json --age 12 < key.txt
```

The agent's image has the gate but neither `uv` nor this folder: mount the folder and run the image's `python` on it, with the key on stdin.

The output is one JSON object per line: a manifest (model, hashes of the question, the gate's source and the case file), one row per check with its verdict and latency, and a summary. The exit code is 0 only when every verdict matched.

| File | What it covers |
|---|---|
| `turn-recovery-cases.json` | A safe change of topic after a refused request, indirect follow-ups to a hazard, ongoing emergencies |
| `bilingual-cases.json` | The same in English and in mixed Spanish and English |
| `prospective-cases.json` | Edge cases written after the first run: holding the object, an adult already handling it |
| `age-cases.json` | Clear-cut cases whose verdict must not depend on the age, replayed with each form of age the gate is told: an age at both ends of the school years, the ages of the first and the last school grade, and an unknown age |

A scenario gives the student's `age` or school `grade` as the platform does, or neither, and the gate is told what it would be told in a session; each row of the output says which. `--age`, `--grade` or `--unknown-age` tells the gate the same in every scenario instead, to see where the age changes a verdict: the labels stay the file's, so a mismatch in such a run is for a person to judge, not a failure of the gate by itself.

The cases are synthetic and their labels were written by the people who built the gate. A passing run is a regression check, not an independent safety assessment. Run it again whenever `MODEL`, `QUESTION`, the thresholds or what the gate is told about the student's age change.
