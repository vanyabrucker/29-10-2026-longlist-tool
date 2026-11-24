"""Eval runs side by side as a Markdown table (for a terminal, a PR or a
weekly note).

    uv run python -m evals.report                 # newest runs per task and model
    uv run python -m evals.report --all           # every run in the log folder
    uv run python -m evals.report --log-dir DIR

One row per run (task, agent model, date, samples, status) with the means of
the scores that decide a model choice. For transcripts and per-sample
detail use `uv run inspect view --log-dir evals/logs`.
"""

from __future__ import annotations

import argparse
from pathlib import Path

from inspect_ai.log import list_eval_logs, read_eval_log

from evals.env import LOG_DIR

COLUMNS = {
    "helios_scenarios": ("passed", "unknown_kept", "unknown_flagged",
                         "non_matches_dropped", "scoring_passed", "criteria_named",
                         "missing_stated", "not_excluded", "flags_raised", "order_ok",
                         "scoring_judge_mean", "tool_error_rate_agent", "infra_broken",
                         "cost_usd", "wall_s", "output_tokens_per_s"),
    "helios_replay": ("judge_mean", "relevance", "grounding", "no_invention",
                      "overlap_recall", "list_created", "fallback_answers",
                      "tool_error_rate_agent", "infra_broken", "model_calls", "cost_usd",
                      "wall_s", "output_tokens_per_s"),
}


def runs(log_dir: Path, newest_only: bool = True) -> list[dict]:
    out, seen = [], set()
    for info in list_eval_logs(str(log_dir)):  # newest first
        log = read_eval_log(info, header_only=True)
        key = (log.eval.task, log.eval.model)
        if newest_only and key in seen:
            continue
        seen.add(key)
        means = {s.name: m.value for s in (log.results.scores if log.results else [])
                 for name, m in s.metrics.items() if name == "mean"}
        out.append({"task": log.eval.task, "model": log.eval.model.removeprefix("helios/"),
                    "date": log.eval.created[:16].replace("T", " "),
                    "samples": log.results.completed_samples if log.results else 0,
                    "status": log.status, "means": means})
    return out


def table(rows: list[dict]) -> str:
    parts = []
    for task in sorted({r["task"] for r in rows}):
        cols = COLUMNS.get(task) or sorted({k for r in rows for k in r["means"]})
        head = ["model", "date", "n", *cols]
        lines = ["| " + " | ".join(head) + " |", "|" + "---|" * len(head)]
        for r in sorted((r for r in rows if r["task"] == task), key=lambda r: r["model"]):
            cells = [f"{r['means'][c]:.3g}" if c in r["means"] else "–" for c in cols]
            status = "" if r["status"] == "success" else f" ({r['status']})"
            lines.append("| " + " | ".join(
                [r["model"] + status, r["date"], str(r["samples"]), *cells]) + " |")
        parts.append(f"### {task}\n\n" + "\n".join(lines))
    return "\n\n".join(parts) or "No eval logs yet."


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m evals.report", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--log-dir", type=Path, default=LOG_DIR)
    p.add_argument("--all", action="store_true", help="every run, not just the newest")
    args = p.parse_args(argv)
    print(table(runs(args.log_dir, newest_only=not args.all)))


if __name__ == "__main__":
    main()
