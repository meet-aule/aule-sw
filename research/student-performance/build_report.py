"""Build a standalone research report and offline explorer from fitted results."""

import html
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def main() -> None:
    results = json.loads((ROOT / "results/results.json").read_text())
    datasets = results["datasets"]
    data = {
        key: {
            "models": value["full_data_models_for_explorer"],
            "metrics": value["models"],
            "baseline": value["models"]["last_grade_G2"],
        }
        for key, value in datasets.items()
    }
    predictor = (
        (ROOT / "predictor.mjs")
        .read_text()
        .replace("export function predict", "function predict")
    )
    fragment = (
        (ROOT / "explorer.template.html")
        .read_text()
        .replace("__MODEL_DATA__", json.dumps(data))
        .replace("__PREDICT_FUNCTION__", predictor)
    )
    (ROOT / "explorer.html").write_text(fragment)
    rows = "".join(
        f"<tr><td>{html.escape(key)}</td>"
        + "".join(
            f"<td>{datasets[s]['models'][key]['mae']:.4f}</td>" for s in ("mat", "por")
        )
        + "</tr>"
        for key in datasets["mat"]["models"]
    )
    template = (ROOT / "report.template.html").read_text()
    report = template.replace("__EXPLORER__", fragment).replace("__RESULT_ROWS__", rows)
    report = report.replace("__FIT_COUNT__", str(results["optimization_audit"]["fits"]))
    (ROOT / "report.html").write_text(report)
    print("Built report.html and explorer.html; all inference stays in the browser")


if __name__ == "__main__":
    main()
