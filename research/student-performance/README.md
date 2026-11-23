# Student performance benchmark

Reproducible research from 2026-11-23, separate from Aule's operational learner
model. It asks whether previous grades, age and educational context predict the
next grade better than simply repeating the last one. No Aule records, credentials
or services are used. The explorer is for synthetic scenarios, not pupil assessment.

## Results and decision

Mean absolute error (MAE), in native grade points from 0 to 20; lower is better:

| Predictor | Mathematics | Portuguese |
|---|---:|---:|
| Training mean | 3.4342 | 2.4088 |
| Repeat G2 | **0.9620** | **0.7673** |
| G1 + G2 | 1.1123 | 0.7887 |
| G1 + G2 + age | 1.1232 | 0.7866 |
| Grades + age + context | 1.1449 | 0.7855 |
| Age + context, without grades | 3.2156 | 2.1616 |

The extended model does not beat G2. Its paired MAE difference against G2 is
+0.18285 [0.08851, 0.28819] in mathematics and +0.01819 [-0.02837, 0.06757] in
Portuguese (95% bootstrap intervals). These intervals condition on the fitted
folds; they do not include full refit uncertainty. School transfer in both
directions also fails to beat G2 in both subjects.

Age adds no clear improvement here. That does not show that age is irrelevant
for adapting primary-school language, activities or instruction. G2 dominates
held-out permutation importance; coefficients and permutations are associations,
not the effect of changing a child's study habits or giving support.

There are only 18 mathematics and 56 Portuguese improvements of at least two
points. The extended model predicts average probabilities of 9.51% and 12.91%,
against observed rates of 4.56% and 8.63%. Its Brier scores (0.0449, 0.0787) are
not convincingly better than fold-specific constant prevalence (0.0442, 0.0792).
Do not use its probabilities for individual decisions or promises of improvement.

**Decision:** keep this as a benchmark, not a production predictor. The public
data do not validate school-level transitions in Aule or identify interventions
that cause progress. No mapping to Peruvian C/B/A/AD was invented.

## Data and provenance

Cortez, P. (2008), [Student Performance, UCI](https://doi.org/10.24432/C5TG7T),
CC BY 4.0. Two Portuguese schools, ages 15–22: 395 mathematics records and 649
Portuguese records. There are 382 pupils shared between subjects: fit and evaluate
each subject separately; do not sum the counts as unique pupils.

`source.json` pins the download URL, attribution and original ZIP SHA-256.
`download_data.py` checks that hash before extracting only the two CSVs and the
data description. Data and generated results are ignored by Git. Source data
retain their original labels; the experiment selects only the protocol's features.
The unused sensitive columns are never inputs or included in generated row outputs.

G1 and G2 are earlier period grades; G3 is the final 0–20 grade and may incorporate
earlier performance. Questionnaire timing is unknown, so context analyses are
retrospective. There are no skill-level answers, hints, spaced practice, retention
probes, tutor interventions or competency rubrics. Primary-school or Peruvian
generalization is untested. All zero grades remain in the main results (38 and 15).

## Method

`protocol.json` is the original protocol, written before the initial fits. No
model choice was selected after viewing outer-fold results. The unchanged design
uses five outer folds (seed 20261123) and three inner folds selecting L2 alpha
from 1, 10 and 100 by MAE. Standardization is fitted within each training split.
All models share outer folds. No subject pooling occurs.

The ordinal model is `mord.LogisticAT`: for ordered observed grades c[j],
`P(G3 <= c[j] | x) = sigmoid(theta[j] - beta * z)`, `z = (x - mean) / scale`.
Class probabilities are differences of cumulative probabilities; the point
prediction is their grade-weighted mean. Study-time categories use equally spaced
ordinal codes, not exact hours. All 540 optimizer calls must converge. The wrapper
only removes a deprecated, ignored SciPy display option and exposes convergence.

Exports fitted on all records drive the explorer; they are not used to estimate
held-out error. `verify.mjs` independently reproduces the Python prediction in
JavaScript, checks probability bounds/sums and guards against invalid exports.

## Reproduce

Requires Python 3.12, Node 24 and `uv`. From this directory:

```sh
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python -r requirements.lock.txt
.venv/bin/python download_data.py
.venv/bin/python experiment.py
.venv/bin/python build_report.py
node verify.mjs
```

Open `report.html` directly in a browser. It includes the explorer, validation
chart and links to the generated metrics and PDF. It sends no inputs to a server
and has no storage or analytics. Ages outside 15–22 suppress predictions even
when age is not selected as a predictor. Only synthetic scenarios belong here.

`results/` contains aggregate metrics, coefficients, fold choices, permutation
importance, school-transfer tests, age/zero-grade slices, out-of-fold predictions
and PNG/PDF figures. Small numeric differences across numerical-library platforms
are possible; optimizer failure stops the run. Generated outputs are not committed.

To validate school progress in Aule, first obtain consented assessments with
teacher-reviewed rubrics, age/grade and reliable timestamps. Reserve later periods
and pupils, compare against the previous grade, and evaluate calibration and errors
by age/grade. Whether an intervention causes improvement needs a separate study
design; predictive associations cannot establish that.
