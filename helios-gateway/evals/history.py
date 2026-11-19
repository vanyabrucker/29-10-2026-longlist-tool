"""Eval history: every run in one place, over time, as an Excel workbook.

    uv run python -m evals.history                    # add new runs, rebuild the workbook
    uv run python -m evals.history --note "score_buyers skill + citations"
    uv run python -m evals.history --set-note RUN_ID "text"
    uv run python -m evals.history --log-dir DIR --out-dir DIR

The Inspect logs in `evals/logs` (local, git-ignored) are read and each run
not seen before is added to two CSV files in `evals/history/`:

- `runs.csv`: one row per run: when, git commit (and whether the tree was
  dirty), task, agent model, **judge model**, hashes of the agent's setup
  (prompt, skills, tools), of the judge's rubrics and of the dataset, epochs,
  samples, a free-text note, then the mean of every score, and the standard
  error of the headline ones.
- `samples.csv`: one row per scenario/chat and epoch with every score; for
  scenarios also the judge's reasons (replays hold private chats: no text).

The CSVs are the record (they diff in git, and an old log can be deleted
without losing its row). `history.xlsx` is rebuilt from them on every call,
with the sheets Trend (line charts over time, one line per agent model and
judge, so a change of judge shows as its own line), Runs and Samples. Don't
edit the workbook: put hand-made graphics in another workbook, or edit the
CSVs (the note column is yours).

Runs only compare when agent model, judge model and dataset match; the
columns say which they are. Runs that predate the hashes leave them empty.
"""

from __future__ import annotations

import argparse
import csv
import math
from pathlib import Path
from typing import Any

from inspect_ai.log import EvalLog, list_eval_logs, read_eval_log
from openpyxl import Workbook
from openpyxl.chart import LineChart, Reference
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter

from evals.env import HERE, LOG_DIR
from evals.report import COLUMNS

HISTORY_DIR = HERE / "history"
RUNS_CSV, SAMPLES_CSV, WORKBOOK = "runs.csv", "samples.csv", "history.xlsx"

RUN_FIELDS = ("run_id", "date", "task", "status", "git_commit", "git_dirty",
              "agent_model", "judge_model", "agent_config", "rubric", "dataset",
              "dataset_hash", "web", "epochs", "samples", "note")
SAMPLE_FIELDS = ("run_id", "date", "task", "agent_model", "judge_model", "sample",
                 "epoch", "error")
# Scores that decide a comparison; they also get a standard error.
HEADLINE = ("passed", "scoring_passed", "scoring_judge_mean", "judge_mean")
JUDGE_SCORERS = ("scoring_judge", "judge")
REASON_LIMIT = 1500

# (task, score, title, y-axis range): the Trend sheet's charts.
CHARTS = (
    ("helios_scenarios", "scoring_passed", "Buyer scoring: chats passing every check", (0, 1)),
    ("helios_scenarios", "scoring_judge_mean", "Buyer scoring: judge mean (1–5)", (1, 5)),
    ("helios_scenarios", "order_ok", "Buyer scoring: better fit ranked higher", (0, 1)),
    ("helios_scenarios", "missing_stated", "Buyer scoring: missing inputs stated", (0, 1)),
    ("helios_scenarios", "passed", "Filtering: chats passing every check", (0, 1)),
    ("helios_replay", "judge_mean", "Replays: judge mean (1–5)", (1, 5)),
    ("helios_scenarios", "cost_usd", "Scenarios: cost per chat (USD)", None),
    ("helios_scenarios", "wall_s", "Scenarios: seconds per chat", None),
)


# ── Reading the logs ───────────────────────────────────────────────────────


def _number(v: Any) -> float | None:
    if isinstance(v, bool):
        return float(v)
    if isinstance(v, (int, float)) and not math.isnan(v):
        return float(v)
    return None


def _flat(value: Any) -> dict[str, float]:
    """A sample score's numbers: a dict's entries, or a bare number."""
    items = value.items() if isinstance(value, dict) else []
    return {k: n for k, v in items if (n := _number(v)) is not None}


def _stderr(values: list[float]) -> float | None:
    if len(values) < 2:
        return None
    mean = sum(values) / len(values)
    var = sum((v - mean) ** 2 for v in values) / (len(values) - 1)
    return math.sqrt(var / len(values))


def read_run(log: EvalLog) -> tuple[dict, list[dict]]:
    """One log as a runs row and its samples rows."""
    meta = {**(log.eval.task_args or {}), **(log.eval.metadata or {})}
    rev = log.eval.revision
    created = log.eval.created.replace("T", " ")[:19]
    base = {
        "run_id": log.eval.eval_id, "date": created, "task": log.eval.task,
        "status": log.status,
        "git_commit": (rev.commit or "")[:7] if rev else "",
        "git_dirty": ("dirty" if rev.dirty else "clean") if rev and rev.dirty is not None else "",
        "agent_model": meta.get("agent_model") or log.eval.model.removeprefix("helios/"),
        "judge_model": meta.get("judge_model", ""),
        "agent_config": meta.get("agent_config", ""), "rubric": meta.get("rubric", ""),
        "dataset": meta.get("dataset", ""), "dataset_hash": meta.get("dataset_hash", ""),
        "web": meta.get("web", ""), "epochs": log.eval.config.epochs or 1,
        "samples": len({s.id for s in log.samples or []}), "note": "",
    }
    if base["dataset"]:
        base["dataset"] = Path(str(base["dataset"])).name
    per_sample, rows = [], []
    for s in log.samples or []:
        numbers: dict[str, float] = {}
        reason = ""
        for name, score in (s.scores or {}).items():
            numbers.update(_flat(score.value))
            if name in JUDGE_SCORERS and score.explanation:
                reason = score.explanation
        per_sample.append(numbers)
        rows.append({
            **{k: base[k] for k in ("run_id", "date", "task", "agent_model", "judge_model")},
            "sample": s.id, "epoch": s.epoch, "error": "error" if s.error else "",
            **numbers,
            # Replays hold private chats: their text stays in the local logs.
            **({"reason": reason[:REASON_LIMIT]} if base["task"] != "helios_replay" else {}),
        })
    means: dict[str, float] = {}
    for sc in (log.results.scores if log.results else []):
        for name, m in sc.metrics.items():
            if name == "mean" and (n := _number(m.value)) is not None:
                means[sc.name] = n
    for key in HEADLINE:
        vals = [p[key] for p in per_sample if key in p]
        if (se := _stderr(vals)) is not None and key in means:
            means[f"{key}_se"] = se
    return {**base, **means}, rows


def read_logs(log_dir: Path) -> list[tuple[dict, list[dict]]]:
    out = []
    for info in list_eval_logs(str(log_dir)):
        log = read_eval_log(info)
        if log.status != "started":
            out.append(read_run(log))
    return out


# ── The CSV record ─────────────────────────────────────────────────────────


def _read_csv(path: Path) -> list[dict]:
    if not path.exists():
        return []
    with path.open(newline="", encoding="utf-8") as f:
        return list(csv.DictReader(f))


def _columns(rows: list[dict], lead: tuple[str, ...], task_order: bool) -> list[str]:
    """Fixed leading columns, then the scores: the report's order first,
    the rest (and standard errors) alphabetically."""
    known = [c for cols in COLUMNS.values() for c in cols] if task_order else []
    rest = sorted({k for r in rows for k in r} - set(lead))
    first = [c for c in dict.fromkeys(known) if c in rest]
    tail = [c for c in rest if c not in first and c != "reason"]
    return [*lead, *first, *tail, *(["reason"] if "reason" in rest else [])]


def _write_csv(path: Path, rows: list[dict], lead: tuple[str, ...], task_order: bool) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    cols = _columns(rows, lead, task_order)
    with path.open("w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=cols, restval="", extrasaction="ignore",
                           lineterminator="\n")
        w.writeheader()
        for r in rows:
            w.writerow({k: ("" if v is None else round(v, 4) if isinstance(v, float) else v)
                        for k, v in r.items()})


def update(log_dir: Path, out_dir: Path, note: str = "") -> int:
    """Add the runs in `log_dir` that `out_dir` doesn't have; returns how many."""
    runs = _read_csv(out_dir / RUNS_CSV)
    samples = _read_csv(out_dir / SAMPLES_CSV)
    seen = {r["run_id"] for r in runs}
    added = 0
    # Runs keep the order they were recorded in (new ones by date among
    # themselves), which is the order of the charts, oldest on the left:
    # runs that overlapped in time can be put in the right order by
    # recording the earlier one first, or by moving its row in runs.csv.
    for run, rows in sorted(read_logs(log_dir), key=lambda x: x[0]["date"]):
        if run["run_id"] in seen:
            continue
        seen.add(run["run_id"])
        runs.append({**run, "note": note})
        samples.extend(rows)
        added += 1
    _write_csv(out_dir / RUNS_CSV, runs, RUN_FIELDS, True)
    _write_csv(out_dir / SAMPLES_CSV, samples, SAMPLE_FIELDS, True)
    return added


def set_note(out_dir: Path, run_id: str, note: str) -> None:
    runs = _read_csv(out_dir / RUNS_CSV)
    hit = [r for r in runs if r["run_id"].startswith(run_id)]
    if len(hit) != 1:
        raise SystemExit(f"{len(hit)} runs match {run_id!r}; give more of the id "
                         "(see the run_id column in runs.csv).")
    hit[0]["note"] = note
    _write_csv(out_dir / RUNS_CSV, runs, RUN_FIELDS, True)


# ── The workbook ───────────────────────────────────────────────────────────

HEADER_FILL = PatternFill("solid", fgColor="F3F4F6")


def _typed(column: str, value: str, lead: tuple[str, ...]) -> Any:
    """CSV text back to a number for score columns (ids and hashes stay text)."""
    if value == "":
        return None
    if column in lead or column == "reason":
        return int(value) if column in ("epochs", "samples", "epoch") and value.isdigit() else value
    try:
        return float(value)
    except ValueError:
        return value


def _sheet(wb: Workbook, title: str, rows: list[dict], lead: tuple[str, ...]) -> None:
    ws = wb.create_sheet(title)
    cols = _columns(rows, lead, True)
    ws.append(cols)
    for r in rows:
        ws.append([_typed(c, r.get(c, ""), lead) for c in cols])
    for cell in ws[1]:
        cell.font = Font(bold=True)
        cell.fill = HEADER_FILL
        cell.alignment = Alignment(vertical="center", wrap_text=True)
    for i, c in enumerate(cols, 1):
        width = 60 if c in ("note", "reason") else 14 if c == "run_id" else max(10, min(18, len(c) + 2))
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.freeze_panes = "A2"
    ws.auto_filter.ref = ws.dimensions


def _series(runs: list[dict], task: str, metric: str) -> tuple[list[str], list[str], list[list]]:
    """Rows (one per run, in the order recorded), one column per agent and judge model."""
    rows = [r for r in runs if r["task"] == task and r["status"] == "success"
            and r.get(metric, "") != ""]
    names = sorted({f"{r['agent_model']} · judge {r['judge_model'] or 'none'}" for r in rows})
    labels, table = [], []
    for r in rows:
        name = f"{r['agent_model']} · judge {r['judge_model'] or 'none'}"
        note = f" {r['note']}" if r["note"] else ""
        labels.append(f"{r['date'][:16]} {r['git_commit']}{note}"[:52])
        table.append([float(r[metric]) if f == name else None for f in names])
    return labels, names, table


def build_workbook(out_dir: Path) -> Path:
    runs = _read_csv(out_dir / RUNS_CSV)
    samples = _read_csv(out_dir / SAMPLES_CSV)
    wb = Workbook()
    trend = wb.active
    trend.title = "Trend"
    data = wb.create_sheet("ChartData")
    trend["A1"] = "Eval trend"
    trend["A1"].font = Font(bold=True, size=14)
    trend["A2"] = ("One line per agent model and judge model: a different judge is a "
                   "different line, so judges can be compared. Source: Runs sheet.")
    col, chart_no = 1, 0
    for task, metric, title, axis in CHARTS:
        labels, names, table = _series(runs, task, metric)
        if not table:
            continue
        data.cell(row=1, column=col, value=f"{title}")
        data.cell(row=2, column=col, value="Run")
        for j, n in enumerate(names, 1):
            data.cell(row=2, column=col + j, value=n)
        for i, (label, vals) in enumerate(zip(labels, table), 3):
            data.cell(row=i, column=col, value=label)
            for j, v in enumerate(vals, 1):
                data.cell(row=i, column=col + j, value=v)
        chart = LineChart()
        chart.title = title
        chart.height, chart.width = 8.5, 17
        chart.y_axis.title = None
        if axis:
            chart.y_axis.scaling.min, chart.y_axis.scaling.max = axis
        chart.add_data(Reference(data, min_col=col + 1, max_col=col + len(names),
                                 min_row=2, max_row=2 + len(table)), titles_from_data=True)
        chart.set_categories(Reference(data, min_col=col, min_row=3, max_row=2 + len(table)))
        for s in chart.series:
            s.marker.symbol = "circle"
            s.marker.size = 7
            s.smooth = False
        chart.display_blanks = "span"
        chart.x_axis.delete = False
        chart.y_axis.delete = False
        chart.legend.position = "b"
        anchor = f"{'A' if chart_no % 2 == 0 else 'K'}{4 + 19 * (chart_no // 2)}"
        trend.add_chart(chart, anchor)
        chart_no += 1
        col += len(names) + 2
    if chart_no == 0:
        trend["A4"] = "No successful runs yet."
    trend.column_dimensions["A"].width = 12
    _sheet(wb, "Runs", runs, RUN_FIELDS)
    _sheet(wb, "Samples", samples, SAMPLE_FIELDS)
    path = out_dir / WORKBOOK
    wb.save(path)
    return path


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m evals.history", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--log-dir", type=Path, default=LOG_DIR)
    p.add_argument("--out-dir", type=Path, default=HISTORY_DIR)
    p.add_argument("--note", default="", help="what changed, for the runs added now")
    p.add_argument("--set-note", nargs=2, metavar=("RUN_ID", "TEXT"),
                   help="change the note of a run already recorded")
    args = p.parse_args(argv)
    if args.set_note:
        set_note(args.out_dir, *args.set_note)
    added = update(args.log_dir, args.out_dir, args.note)
    path = build_workbook(args.out_dir)
    print(f"Added {added} run(s); workbook: {path}")


if __name__ == "__main__":
    main()
