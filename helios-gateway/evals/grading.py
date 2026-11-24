"""Hand grading: a scenario run as a spreadsheet to grade, and the grades back.

    uv run python -m evals.grading export evals/logs/<run>.eval     # → evals/grading/<run>.xlsx
    uv run python -m evals.grading read evals/grading/<run>.xlsx     # agreement with the judge
    uv run python -m evals.grading read evals/grading/<run>.xlsx --write-log --author "Name"

The workbook has a sheet per kind of check, with your columns in blue:
- **Chats**: one row per scoring chat (scenario × epoch), the judge's four
  grades and reasons next to an empty column for each of yours (1–5, same
  rubric) and a comment.
- **Rationales**: one row per buyer the agent scored: the facts it had, its
  score and rationale, and your verdict, your score and a comment.
- **Filters**: one row per filter chat: the instruction, what should stay,
  what's left, the scorer's verdict and yours.

`read` compares your chat grades with the judge's (mean difference, exact
and within-one agreement per criterion), counts the rationale verdicts and
lists your comments: where you and the judge disagree is what to fix in the
rubric or the skills. `--write-log` also adds your chat grades to the eval
log as a `human_scoring` score (Inspect's `edit_score`, with you as the
author), so the viewer shows them next to the judge's.
"""

from __future__ import annotations

import argparse
import statistics
from pathlib import Path
from typing import Any

from openpyxl import Workbook, load_workbook
from openpyxl.styles import Alignment, Font, PatternFill
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation

from evals.scorers import SCORING_CRITERIA, infra_failure, result_list

HERE = Path(__file__).resolve().parent
OUT_DIR = HERE / "grading"
YOURS = PatternFill("solid", fgColor="DBE9FB")  # your columns
HEAD = Font(bold=True)
WRAP = Alignment(wrap_text=True, vertical="top")
VERDICTS = ("Good", "Score too high", "Score too low", "Weak rationale",
            "Invented fact", "Wrong criteria")
FILTER_VERDICTS = ("Correct", "Wrong")

CRITERIA_HELP = {
    "criteria_fit": "Right criteria for the buyer type (strategic: sector, size; sponsor: "
                    "ticket, scope; VC: stage) and scores consistent with them.",
    "evidence": "Tied to the facts shown, with figures and periods; inference marked as "
                "inference.",
    "uncertainty": "Missing inputs named and their effect on confidence said; no zero "
                   "scores for unknowns; losses, ownership and group overlaps raised.",
    "no_invention": "No facts, figures or deals that aren't in the material. One clear "
                    "invention caps it at 2.",
}


# ── Export ─────────────────────────────────────────────────────────────────


def _money(v: dict) -> str:
    amount = v.get("amount")
    if amount is None:
        return ""
    m = amount / 1e6
    return f"{v.get('currency') or ''} {m:g}m".strip()


def _fact(value: Any) -> str:
    if isinstance(value, dict):
        if "amount" in value:
            return _money(value)
        if "country" in value or "city" in value:
            return ", ".join(str(value[k]) for k in ("city", "region", "country")
                             if value.get(k))
        return "; ".join(f"{k}: {_fact(v)}" for k, v in value.items() if v is not None)
    if isinstance(value, list):
        return ", ".join(_fact(v) for v in value)
    return str(value)


def facts(row: dict) -> str:
    return "\n".join(f"{k}: {_fact(v)}" for k, v in (row.get("values") or {}).items()
                     if v not in (None, "", [], {}))


def replies(replay: dict) -> str:
    return "\n\n".join(e["payload"]["text"] for e in replay.get("events") or []
                       if e["type"] == "agent.message" and e["payload"].get("text"))


def _judge_reasons(explanation: str | None) -> dict[str, str]:
    out = {}
    for line in (explanation or "").splitlines():
        key, _, rest = line.partition(":")
        if key.strip() in SCORING_CRITERIA:
            out[key.strip()] = rest.split("–", 1)[-1].strip()
    return out


def _sheet(wb: Workbook, title: str, columns: list[tuple[str, int, bool]]):
    ws = wb.create_sheet(title)
    for i, (name, width, yours) in enumerate(columns, 1):
        cell = ws.cell(row=1, column=i, value=name)
        cell.font = HEAD
        if yours:
            cell.fill = YOURS
        ws.column_dimensions[get_column_letter(i)].width = width
    ws.freeze_panes = "A2"
    return ws


def _add(ws, values: list, yours: set[int]) -> int:
    ws.append(values)
    r = ws.max_row
    for i in range(1, len(values) + 1):
        c = ws.cell(row=r, column=i)
        c.alignment = WRAP
        if i in yours:
            c.fill = YOURS
    return r


def _validate(ws, col: int, rows: int, dv: DataValidation) -> None:
    if rows < 2:
        return
    letter = get_column_letter(col)
    ws.add_data_validation(dv)
    dv.add(f"{letter}2:{letter}{rows}")


def export(log_path: Path, out: Path | None = None) -> Path:
    from inspect_ai.log import read_eval_log

    log = read_eval_log(str(log_path))
    out = out or OUT_DIR / f"{log_path.stem}.xlsx"
    wb = Workbook()
    intro = wb.active
    intro.title = "How to grade"
    lines = [
        "Hand grading",
        (f"Run: {log_path.name} · agent {log.eval.model} · "
         f"judge {log.eval.task_args.get('judge_model')}"),
        "Fill in the blue columns only. Leave a cell empty to skip it.",
        ("Chats: grade each scoring chat 1 (bad) to 5 (excellent) on the judge's four "
         "criteria, without looking at the judge's grades first if you can."),
        ("Rationales: pick a verdict per buyer; add your own score (0–100) if the "
         "agent's is off, and a comment saying why."),
        ("Filters: Correct if the list keeps the matches, drops clear non-matches and "
         "keeps and flags rows whose deciding value is unknown."),
        "Rows marked 'infrastructure failure' broke on our side: skip them.",
        "",
        "Criteria",
        *[f"{k}: {v}" for k, v in CRITERIA_HELP.items()],
    ]
    for text in lines:
        intro.append([text])
    intro["A1"].font = Font(bold=True, size=14)
    intro.column_dimensions["A"].width = 140

    chats = _sheet(wb, "Chats", [
        ("Sample", 26, False), ("Epoch", 7, False), ("Scenario", 40, False),
        ("Mandate and instruction", 60, False), ("Agent's reply", 70, False),
        ("Final list", 90, False),
        *[(f"Judge {c}", 10, False) for c in SCORING_CRITERIA],
        ("Judge's reasons", 70, False),
        *[(f"Your {c}", 10, True) for c in SCORING_CRITERIA],
        ("Your comment", 50, True), ("Note", 24, False)])
    rationales = _sheet(wb, "Rationales", [
        ("Sample", 26, False), ("Epoch", 7, False), ("Buyer", 28, False),
        ("Facts on the list", 45, False), ("Agent score", 9, False),
        ("Agent rationale", 90, False), ("Your verdict", 18, True),
        ("Your score", 9, True), ("Your comment", 50, True)])
    filters = _sheet(wb, "Filters", [
        ("Sample", 26, False), ("Epoch", 7, False), ("Instruction", 50, False),
        ("Should keep", 30, False), ("Should keep and flag (unknown)", 30, False),
        ("Should drop", 30, False), ("List after", 70, False),
        ("Agent's reply", 70, False), ("Scorer: passed", 9, False),
        ("Your verdict", 12, True), ("Your comment", 50, True), ("Note", 24, False)])

    n_chat = len(SCORING_CRITERIA)
    for s in sorted(log.samples or [], key=lambda x: (str(x.id), x.epoch)):
        sample = (s.metadata or {}).get("sample") or {}
        replay = s.store.get("helios") or {}
        broken = infra_failure(replay)
        note = f"Infrastructure failure: {broken}" if broken else ""
        lst = result_list(replay) or {"rows": []}
        if sample.get("behaviour") == "fit_scoring":
            judge = s.scores.get("scoring_judge") if s.scores else None
            value = judge.value if judge and isinstance(judge.value, dict) else {}
            reasons = _judge_reasons(judge.explanation if judge else None)
            listing = "\n\n".join(
                f"{r['name']} — {r.get('relevance_score')}\n{facts(r)}" for r in lst["rows"])
            first_yours = 7 + n_chat + 1
            _add(chats, [
                s.id, s.epoch, sample.get("title"), s.input if isinstance(s.input, str)
                else str(s.input), replies(replay), listing,
                *[value.get(c) for c in SCORING_CRITERIA],
                "\n".join(f"{c}: {reasons.get(c, '')}" for c in SCORING_CRITERIA),
                *[None] * n_chat, None, note],
                set(range(first_yours, first_yours + n_chat + 1)))
            for r in lst["rows"]:
                _add(rationales, [s.id, s.epoch, r["name"], facts(r), r.get("relevance_score"),
                                  r.get("relevance_explanation"), None, None, None],
                     {7, 8, 9})
        elif sample.get("behaviour") == "missing_data_on_filter":
            expect = sample.get("expect") or {}
            fr = s.scores.get("filter_retention") if s.scores else None
            passed = fr.value.get("passed") if fr and isinstance(fr.value, dict) else None
            left = "\n\n".join(f"{r['name']}\n{facts(r)}"
                               + (f"\nNote: {r['relevance_explanation']}"
                                  if r.get("relevance_explanation") else "")
                               for r in lst["rows"])
            _add(filters, [s.id, s.epoch, s.input if isinstance(s.input, str)
                           else str(s.input), ", ".join(expect.get("keep") or []),
                           ", ".join(expect.get("flag") or []),
                           ", ".join(expect.get("drop") or []), left, replies(replay),
                           passed, None, None, note], {10, 11})

    first_yours = 7 + n_chat + 1
    for i in range(n_chat):
        _validate(chats, first_yours + i, chats.max_row, DataValidation(
            type="decimal", operator="between", formula1="1", formula2="5",
            allow_blank=True, error="A grade from 1 to 5 (half points are fine).",
            showErrorMessage=True))
    _validate(rationales, 7, rationales.max_row, DataValidation(
        type="list", formula1='"' + ",".join(VERDICTS) + '"', allow_blank=True))
    _validate(rationales, 8, rationales.max_row, DataValidation(
        type="whole", operator="between", formula1="0", formula2="100", allow_blank=True,
        error="A score from 0 to 100.", showErrorMessage=True))
    _validate(filters, 10, filters.max_row, DataValidation(
        type="list", formula1='"' + ",".join(FILTER_VERDICTS) + '"', allow_blank=True))

    meta = wb.create_sheet("_meta")
    meta.append(["log", str(log_path.resolve())])
    meta.sheet_state = "hidden"
    out.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out)
    return out


# ── Read back ──────────────────────────────────────────────────────────────


def _rows(ws) -> list[dict[str, Any]]:
    values = list(ws.iter_rows(values_only=True))
    head = values[0]
    # A cell holding only spaces counts as empty (a cleared dropdown keeps one).
    clean = [[None if isinstance(v, str) and not v.strip() else v for v in r]
             for r in values[1:]]
    return [dict(zip(head, r, strict=False)) for r in clean if any(v is not None for v in r)]


def agreement(chats: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    """Per criterion over chats you graded: your mean, the judge's, the mean
    of (judge − you), and how often you agree exactly or within one point."""
    out = {}
    for c in SCORING_CRITERIA:
        pairs = [(float(r[f"Judge {c}"]), float(r[f"Your {c}"])) for r in chats
                 if r.get(f"Your {c}") is not None and r.get(f"Judge {c}") is not None]
        if not pairs:
            continue
        diffs = [j - y for j, y in pairs]
        out[c] = {"n": len(pairs), "you": round(statistics.mean(y for _, y in pairs), 2),
                  "judge": round(statistics.mean(j for j, _ in pairs), 2),
                  "judge_minus_you": round(statistics.mean(diffs), 2),
                  "exact": round(sum(d == 0 for d in diffs) / len(diffs), 2),
                  "within_one": round(sum(abs(d) <= 1 for d in diffs) / len(diffs), 2)}
    return out


def read(path: Path, write_log: bool = False, author: str | None = None) -> None:
    wb = load_workbook(path, data_only=True)
    chats = _rows(wb["Chats"])
    rationales = _rows(wb["Rationales"])
    filters = _rows(wb["Filters"])

    table = agreement(chats)
    graded_chats = sum(1 for r in chats if any(r.get(f"Your {c}") is not None
                                               for c in SCORING_CRITERIA))
    print(f"Chats graded: {graded_chats} of {len(chats)}")
    if table:
        print("| criterion | n | you | judge | judge − you | exact | within 1 |")
        print("| --- | --- | --- | --- | --- | --- | --- |")
        for c, a in table.items():
            print(f"| {c} | {a['n']} | {a['you']} | {a['judge']} | {a['judge_minus_you']:+} "
                  f"| {a['exact']:.0%} | {a['within_one']:.0%} |")
    verdicts: dict[str, int] = {}
    for r in rationales:
        if r.get("Your verdict"):
            verdicts[r["Your verdict"]] = verdicts.get(r["Your verdict"], 0) + 1
    print(f"\nRationales graded: {sum(verdicts.values())} of {len(rationales)}")
    for v, n in sorted(verdicts.items(), key=lambda x: -x[1]):
        print(f"- {v}: {n}")
    graded = [r for r in filters if r.get("Your verdict")]
    agree = sum((r["Your verdict"] == "Correct") == bool(r.get("Scorer: passed"))
                for r in graded)
    print(f"\nFilters graded: {len(graded)} of {len(filters)}; the scorer agrees with you "
          f"on {agree}")
    comments = [(r["Sample"], r["Epoch"], r.get("Buyer"), r["Your comment"])
                for r in chats + rationales + filters if r.get("Your comment")]
    if comments:
        print("\nComments:")
        for sample, epoch, buyer, text in comments:
            print(f"- {sample} #{epoch}{f' · {buyer}' if buyer else ''}: {text}")

    if write_log:
        if not author:
            raise SystemExit("--write-log needs --author (who graded).")
        _write_log(wb, chats, author)


def _write_log(wb, chats: list[dict[str, Any]], author: str) -> None:
    from inspect_ai.log import ProvenanceData, edit_score, read_eval_log, write_eval_log
    from inspect_ai.scorer import ScoreEdit

    log_path = next(r[1] for r in wb["_meta"].iter_rows(values_only=True) if r[0] == "log")
    log = read_eval_log(log_path)
    n = 0
    for r in chats:
        grades = {c: float(r[f"Your {c}"]) for c in SCORING_CRITERIA
                  if r.get(f"Your {c}") is not None}
        if len(grades) != len(SCORING_CRITERIA):
            continue
        grades["human_scoring_mean"] = round(sum(grades.values()) / len(SCORING_CRITERIA), 3)
        edit_score(log, r["Sample"], "human_scoring", ScoreEdit(
            value=grades, explanation=r.get("Your comment"),
            provenance=ProvenanceData(author=author, reason="hand grading")),
            recompute_metrics=False, epoch=int(r["Epoch"]))
        n += 1
    write_eval_log(log, log_path)
    print(f"\nWrote {n} hand grades to {log_path} as the score human_scoring.")


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="python -m evals.grading", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    e = sub.add_parser("export", help="a scenario run as a grading workbook")
    e.add_argument("log", type=Path)
    e.add_argument("--out", type=Path)
    r = sub.add_parser("read", help="your grades: agreement with the judge, comments")
    r.add_argument("workbook", type=Path)
    r.add_argument("--write-log", action="store_true",
                   help="also add your chat grades to the eval log")
    r.add_argument("--author", help="who graded (for --write-log)")
    a = p.parse_args(argv)
    if a.cmd == "export":
        print(export(a.log, a.out))
    else:
        read(a.workbook, a.write_log, a.author)


if __name__ == "__main__":
    main()
