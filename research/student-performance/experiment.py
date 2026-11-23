"""Reproducible, isolated benchmark; no Aule records or service connections."""

from __future__ import annotations

import hashlib
import importlib.metadata
import json
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import mord
import numpy as np
import pandas as pd
from scipy.special import expit
from sklearn.metrics import mean_absolute_error, mean_squared_error, roc_auc_score
from sklearn.model_selection import KFold
from sklearn.preprocessing import StandardScaler

# mord 0.7 passes a removed SciPy display option and does not expose convergence.
# Audit every solve; dropping the ignored display option changes no optimization.
ORIGINAL_MINIMIZE = mord.threshold_based.optimize.minimize
SOLVES = []


def checked_minimize(*args: Any, **kwargs: Any) -> Any:
    kwargs["options"] = dict(kwargs.get("options", {}))
    kwargs["options"].pop("disp", None)
    solved = ORIGINAL_MINIMIZE(*args, **kwargs)
    SOLVES.append(
        {
            "success": bool(solved.success),
            "iterations": int(solved.nit),
            "message": str(solved.message),
        }
    )
    if not solved.success:
        raise RuntimeError(f"Ordinal optimization did not converge: {solved.message}")
    return solved


mord.threshold_based.optimize.minimize = checked_minimize

ROOT = Path(__file__).resolve().parent
RESULTS = ROOT / "results"
CONFIG = json.loads((ROOT / "protocol.json").read_text())
SEED = CONFIG["seed"]
FEATURES = CONFIG["models"]
LABELS = {
    "training_mean": "Training mean",
    "last_grade_G2": "Repeat last grade (G2)",
    "grades": "Previous grades",
    "grades_age": "Grades + age",
    "extended": "Grades + age + context",
    "context_only": "Age + context, no grades",
}


def numeric(frame: pd.DataFrame, columns: list[str]) -> np.ndarray:
    result = frame[columns].copy()
    for column in ["schoolsup", "famsup"]:
        if column in columns:
            result[column] = result[column].map({"yes": 1.0, "no": 0.0})
    array = result.to_numpy(dtype=float)
    assert np.isfinite(array).all()
    return array


@dataclass
class OrdinalModel:
    columns: list[str]
    alpha: float

    def fit(self, frame: pd.DataFrame, y: np.ndarray) -> OrdinalModel:
        self.scaler = StandardScaler().fit(numeric(frame, self.columns))
        self.classes, encoded = np.unique(y, return_inverse=True)
        assert len(self.classes) >= 2
        self.estimator = mord.LogisticAT(alpha=self.alpha, max_iter=1000)
        self.estimator.fit(self.scaler.transform(numeric(frame, self.columns)), encoded)
        assert np.diff(self.estimator.theta_).min() >= -1e-8
        return self

    def probabilities(self, frame: pd.DataFrame) -> np.ndarray:
        small = self.estimator.predict_proba(
            self.scaler.transform(numeric(frame, self.columns))
        )
        p = np.zeros((len(frame), 21))
        p[:, self.classes] = small
        assert np.isfinite(p).all() and p.min() >= -1e-9
        assert np.allclose(p.sum(axis=1), 1.0)
        return p

    def export(self) -> dict:
        return {
            "features": self.columns,
            "alpha": self.alpha,
            "mean": self.scaler.mean_.tolist(),
            "scale": self.scaler.scale_.tolist(),
            "coefficients_standardized": self.estimator.coef_.tolist(),
            "coefficients_raw": (self.estimator.coef_ / self.scaler.scale_).tolist(),
            "thresholds": self.estimator.theta_.tolist(),
            "grades": self.classes.tolist(),
        }


def expected(p: np.ndarray) -> np.ndarray:
    return p @ np.arange(21)


def improve_probability(p: np.ndarray, g2: np.ndarray) -> np.ndarray:
    return (p * (np.arange(21)[None, :] >= (g2 + 2)[:, None])).sum(axis=1)


def select_alpha(
    frame: pd.DataFrame, y: np.ndarray, columns: list[str], seed: int
) -> float:
    inner = list(KFold(n_splits=3, shuffle=True, random_state=seed).split(frame))
    errors = []
    for alpha in CONFIG["alpha_grid"]:
        losses = []
        for train, test in inner:
            model = OrdinalModel(columns, alpha).fit(frame.iloc[train], y[train])
            losses.extend(
                np.abs(
                    expected(model.probabilities(frame.iloc[test])) - y[test]
                ).tolist()
            )
        errors.append(np.mean(losses))
    return float(CONFIG["alpha_grid"][int(np.argmin(errors))])


def interval(values: np.ndarray, seed: int = SEED) -> list[float]:
    rng = np.random.default_rng(seed)
    samples = rng.integers(0, len(values), size=(2000, len(values)))
    return np.quantile(values[samples].mean(axis=1), [0.025, 0.975]).tolist()


def metrics(
    y: np.ndarray, prediction: np.ndarray, p: np.ndarray | None, g2: np.ndarray
) -> dict:
    errors = np.abs(y - prediction)
    result = {
        "n": len(y),
        "mae": float(errors.mean()),
        "mae_ci95": interval(errors),
        "rmse": float(np.sqrt(mean_squared_error(y, prediction))),
        "within_2": float((errors <= 2).mean()),
    }
    if p is not None:
        cumulative = np.cumsum(p, axis=1)[:, :-1]
        truth = (y[:, None] <= np.arange(20)[None, :]).astype(float)
        event = (y >= g2 + 2).astype(float)
        probability = improve_probability(p, g2)
        result.update(
            {
                "rps": float(np.mean((cumulative - truth) ** 2)),
                "improve2_brier": float(np.mean((probability - event) ** 2)),
                "improve2_auc": float(roc_auc_score(event, probability))
                if len(np.unique(event)) > 1
                else None,
                "predicted_improve2_rate": float(probability.mean()),
            }
        )
    return result


def run_subject(subject: str) -> tuple[dict, pd.DataFrame]:
    start = time.monotonic()
    frame = pd.read_csv(ROOT / f"data/student-{subject}.csv", sep=";")
    assert not frame.isna().any().any() and not frame.duplicated().any()
    y = frame.G3.to_numpy(int)
    g2 = frame.G2.to_numpy(int)
    assert ((0 <= y) & (y <= 20)).all()
    n = len(frame)
    splits = list(KFold(n_splits=5, shuffle=True, random_state=SEED).split(frame))
    fold_ids = np.full(n, -1)
    predictions = {key: np.zeros(n) for key in LABELS}
    probabilities = {key: np.zeros((n, 21)) for key in FEATURES}
    event_baseline = np.zeros(n)
    parameters, importance, fold_results = [], [], []
    for fold, (train, test) in enumerate(splits):
        assert not set(train).intersection(test)
        assert (fold_ids[test] == -1).all()
        fold_ids[test] = fold
        predictions["training_mean"][test] = y[train].mean()
        predictions["last_grade_G2"][test] = g2[test]
        event_baseline[test] = (y[train] >= g2[train] + 2).mean()
        for key, columns in FEATURES.items():
            alpha = select_alpha(frame.iloc[train], y[train], columns, SEED + fold)
            model = OrdinalModel(columns, alpha).fit(frame.iloc[train], y[train])
            p = model.probabilities(frame.iloc[test])
            probabilities[key][test] = p
            predictions[key][test] = expected(p)
            parameters.append({"fold": fold, "model": key, "alpha": alpha})
            fold_results.append(
                {
                    "fold": fold,
                    "model": key,
                    "n": len(test),
                    "mae": float(mean_absolute_error(y[test], expected(p))),
                }
            )
            if key == "extended":
                baseline_loss = mean_absolute_error(y[test], expected(p))
                rng = np.random.default_rng(SEED + fold)
                for column in columns:
                    increases = []
                    for _ in range(10):
                        permuted = frame.iloc[test].copy()
                        permuted[column] = rng.permutation(permuted[column].to_numpy())
                        increases.append(
                            mean_absolute_error(
                                y[test], expected(model.probabilities(permuted))
                            )
                            - baseline_loss
                        )
                    importance.append(
                        {
                            "fold": fold,
                            "feature": column,
                            "n": len(test),
                            "mae_increase": float(np.mean(increases)),
                        }
                    )
        print(f"{subject}: outer fold {fold + 1}/5 complete", flush=True)
    assert (fold_ids >= 0).all()
    result = {
        "subject": subject,
        "n": n,
        "age_range": [int(frame.age.min()), int(frame.age.max())],
        "schools": frame.school.value_counts().to_dict(),
        "zero_final": int((y == 0).sum()),
        "improved_2": int((y >= g2 + 2).sum()),
        "improve2_base_rate": float((y >= g2 + 2).mean()),
        "improve2_constant_brier": float(
            np.mean((event_baseline - (y >= g2 + 2)) ** 2)
        ),
        "models": {
            key: metrics(y, prediction, probabilities.get(key), g2)
            for key, prediction in predictions.items()
        },
        "fold_parameters": parameters,
        "fold_metrics": fold_results,
        "permutation_importance": {
            column: float(
                np.average(
                    [r["mae_increase"] for r in importance if r["feature"] == column],
                    weights=[r["n"] for r in importance if r["feature"] == column],
                )
            )
            for column in FEATURES["extended"]
        },
    }
    comparisons = {}
    for candidate, baseline in [
        ("extended", "last_grade_G2"),
        ("extended", "grades"),
        ("grades_age", "grades"),
    ]:
        difference = np.abs(predictions[candidate] - y) - np.abs(
            predictions[baseline] - y
        )
        comparisons[f"{candidate}_minus_{baseline}"] = {
            "mae_difference": float(difference.mean()),
            "ci95": interval(difference),
        }
    result["paired_comparisons"] = comparisons
    result["slices"] = {}
    for name, mask in {
        "age_15_17": frame.age.to_numpy() <= 17,
        "age_18_22": frame.age.to_numpy() >= 18,
        "G3_zero": y == 0,
        "G3_positive": y > 0,
    }.items():
        result["slices"][name] = {
            "n": int(mask.sum()),
            **{
                key: float(np.abs(predictions[key][mask] - y[mask]).mean())
                for key in ["last_grade_G2", "grades", "extended"]
            },
        }
    result["school_transfer"] = []
    for school in sorted(frame.school.unique()):
        train = np.where(frame.school.to_numpy() != school)[0]
        test = np.where(frame.school.to_numpy() == school)[0]
        entry = {
            "test_school": school,
            "train_n": len(train),
            "test_n": len(test),
            "last_grade_mae": float(mean_absolute_error(y[test], g2[test])),
        }
        for key in ["grades", "extended"]:
            alpha = select_alpha(frame.iloc[train], y[train], FEATURES[key], SEED)
            model = OrdinalModel(FEATURES[key], alpha).fit(frame.iloc[train], y[train])
            entry[key + "_mae"] = float(
                mean_absolute_error(
                    y[test], expected(model.probabilities(frame.iloc[test]))
                )
            )
        result["school_transfer"].append(entry)
    exports = {}
    for key in ["grades", "grades_age", "extended"]:
        alpha = select_alpha(frame, y, FEATURES[key], SEED)
        model = OrdinalModel(FEATURES[key], alpha).fit(frame, y)
        exports[key] = model.export()
        # Independent reconstruction validates the exact formula used by the interactive view.
        synthetic = pd.DataFrame(
            [
                {
                    "G1": 10,
                    "G2": 11,
                    "age": 16,
                    "studytime": 2,
                    "failures": 0,
                    "schoolsup": "no",
                    "famsup": "yes",
                }
            ]
        )
        serialized = exports[key]
        z = (
            numeric(synthetic, serialized["features"]) - serialized["mean"]
        ) / serialized["scale"]
        cdf = expit(
            np.asarray(serialized["thresholds"])
            - z @ np.asarray(serialized["coefficients_standardized"])
        )
        exported_p = np.diff(np.r_[0, cdf.ravel(), 1])
        assert np.allclose(
            expected(model.probabilities(synthetic))[0],
            exported_p @ np.array(serialized["grades"]),
            atol=1e-10,
        )
        serialized["synthetic_check"] = {
            "features": {
                "G1": 10,
                "G2": 11,
                "age": 16,
                "studytime": 2,
                "failures": 0,
                "schoolsup": 0,
                "famsup": 1,
            },
            "expected_grade": float(exported_p @ np.array(serialized["grades"])),
        }
    result["full_data_models_for_explorer"] = exports
    result["seconds"] = time.monotonic() - start
    output = pd.DataFrame({"row": np.arange(n), "fold": fold_ids, "G2": g2, "G3": y})
    for key, prediction in predictions.items():
        output[key] = prediction
    for key, p in probabilities.items():
        output[key + "_improve2_probability"] = improve_probability(p, g2)
    output["improve2_prior_probability"] = event_baseline
    output.to_csv(RESULTS / f"{subject}-out-of-fold.csv", index=False)
    (RESULTS / f"{subject}-results.json").write_text(
        json.dumps(result, indent=2) + "\n"
    )
    return result, output


def plots(all_results: dict, predictions: dict) -> None:
    plt.rcParams.update(
        {
            "font.family": "DejaVu Sans",
            "font.size": 11,
            "axes.spines.top": False,
            "axes.spines.right": False,
        }
    )
    fig, axes = plt.subplots(2, 2, figsize=(13, 9), layout="constrained")
    keys = ["last_grade_G2", "grades", "grades_age", "extended", "context_only"]
    for col, subject in enumerate(["mat", "por"]):
        result = all_results[subject]
        ax = axes[0, col]
        values = [result["models"][k]["mae"] for k in keys]
        cis = np.array([result["models"][k]["mae_ci95"] for k in keys])
        ax.barh(
            np.arange(len(keys)),
            values,
            color=["#687582", "#457b9d", "#457b9d", "#167d75", "#687582"],
        )
        ax.errorbar(
            values,
            np.arange(len(keys)),
            xerr=np.maximum(0, np.array([values - cis[:, 0], cis[:, 1] - values])),
            fmt="none",
            ecolor="#243b53",
            capsize=3,
        )
        ax.set_yticks(np.arange(len(keys)), [LABELS[k] for k in keys])
        ax.invert_yaxis()
        ax.set_xlabel("Mean absolute error · points on 0–20 scale (lower is better)")
        ax.set_xlim(0, max(cis[:, 1]) * 1.3)
        for i, v in enumerate(values):
            ax.text(cis[i, 1] + 0.06, i, f"{v:.2f}", va="center")
        ax.set_title(
            ("Mathematics" if subject == "mat" else "Portuguese")
            + f" · {result['n']} records"
        )
        ax = axes[1, col]
        frame = predictions[subject]
        for key, color, marker in [
            ("grades", "#457b9d", "o"),
            ("extended", "#167d75", "s"),
        ]:
            p = frame[key + "_improve2_probability"].to_numpy()
            y = (frame.G3 >= frame.G2 + 2).to_numpy()
            order = np.argsort(p)
            bins = np.array_split(order, 5)
            means = [p[b].mean() for b in bins]
            rates = [y[b].mean() for b in bins]
            ax.plot(means, rates, marker=marker, label=LABELS[key], color=color)
        ax.plot([0, 1], [0, 1], ":", color="#687582", label="Ideal calibration")
        ax.set_xlim(0, 0.65)
        ax.set_ylim(0, 0.65)
        ax.set_xlabel("Estimated probability of gaining ≥2 points")
        ax.set_ylabel("Observed held-out frequency")
        ax.set_title(f"Calibration · {result['improved_2']} observed improvements")
        ax.legend(fontsize=9)
    fig.suptitle(
        "Ordinal model: out-of-fold predictions · 5 folds\nPortuguese UCI data; no equivalence to C/B/A/AD",
        fontsize=15,
    )
    fig.savefig(RESULTS / "validacion.png", dpi=160)
    fig.savefig(RESULTS / "validacion.pdf")
    plt.close(fig)


if __name__ == "__main__":
    RESULTS.mkdir(exist_ok=True)
    results, outputs = {}, {}
    for subject in ["mat", "por"]:
        results[subject], outputs[subject] = run_subject(subject)
    plots(results, outputs)
    combined = {
        "protocol_sha256": hashlib.sha256(
            (ROOT / "protocol.json").read_bytes()
        ).hexdigest(),
        "script_sha256": hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
        "datasets": results,
        "optimization_audit": {
            "fits": len(SOLVES),
            "all_converged": all(s["success"] for s in SOLVES),
            "max_iterations": max(s["iterations"] for s in SOLVES),
        },
        "versions": {
            name: importlib.metadata.version(name)
            for name in [
                "numpy",
                "pandas",
                "scipy",
                "scikit-learn",
                "mord",
                "matplotlib",
            ]
        },
    }
    (RESULTS / "results.json").write_text(json.dumps(combined, indent=2) + "\n")
    print(
        json.dumps(
            {
                subject: {
                    "metrics": result["models"],
                    "differences": result["paired_comparisons"],
                    "school_transfer": result["school_transfer"],
                    "importance": result["permutation_importance"],
                }
                for subject, result in results.items()
            },
            indent=2,
        ),
        flush=True,
    )
