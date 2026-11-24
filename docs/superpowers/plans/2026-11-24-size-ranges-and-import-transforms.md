# Employee Ranges and Import Transformations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Employees becomes one range value (`{low, high}`) across imports, search, lists, exports and the agent; the import mapping gets three transformations (treat as empty, combine columns, scale) chosen from a fixed menu.

**Architecture:** Part 1 adds a catalogue type `int_range`, one normalizer, a frozen-SQL migration of stored values, `employees_low`/`employees_high` in `company_search` with an overlap filter, range-aware export and comparison, and text display for the agent and the frontend. Part 2 adds `app/ingest/transforms.py` (Pydantic union + one apply function) used by the mapping LLM answer, the tables PUT, the import detail preview, the corpus report and the list diff, plus chips and a popover on the mapping screen.

**Tech Stack:** FastAPI, SQLAlchemy, Alembic (frozen SQL), Postgres; Next.js 16, React 19, Tailwind v4.

**Spec:** `docs/superpowers/specs/2026-11-24-size-ranges-and-import-transforms-design.md`

## Global Constraints

- Work on branch `feat/size-ranges` (from `main`). Commit per task; never push.
- No new dependencies of any kind (root AGENTS.md).
- No fallbacks: a value that can't be read raises `Invalid` (an error in the report), never a guess.
- Before every commit: `helios-gateway/./scripts/check.sh` (ruff + pytest, `docker compose up -d`) and/or `helios-frontend/npm run check`; fix every lint error.
- Value shape: `{"low": int | None, "high": int | None}`, at least one bound set, `low <= high` when both set. An exact figure is `{low: n, high: n}`.
- Catalogue key stays `employee_count`, label "Employees"; `CATALOGUE_VERSION = "2026-11-24.1"`.
- Read APIs return the object `{low, high}`; only the agent gets text, formatted `11–50` (en dash), `37`, `10001+`, `up to 9`.
- Filter by overlap: `(high IS NULL OR high >= :min) AND (low IS NULL OR low <= :max)`; a half-open range counts as having a figure.
- Two ranges are equal when both bounds are equal ("11-50" equals "11–50").
- Transforms: exactly `empty_values {values}`, `combine {columns, separator=", "}`, `scale {factor: 1000 | 1000000}`; applied in order before `normalize`; never on verified Helios exports; never code from the LLM.
- Frontend: every string in `src/lib/i18n.ts` with German (Swiss spelling, "Sie"); Feather icons only; buttons `rounded-full`; popovers `rounded-xl border-line p-1`, soft shadow, 36px rows; tooltips black 12px.
- Harness rule: agent-facing changes (Task 4) require `helios_scenarios` 3 epochs before/after, `evals.history`, and a report (Task 11).

## Review Focus

1. A CSV opened and saved in Excel turns "1-10" into a date (1 October): the employee cell arrives as a `datetime`; expect `Invalid` naming the date, never a number. Test in Task 1.
2. Thousands separators inside bands ("1'001-5'000", "1,001-5,000", "1 001 – 5 000") parse as ranges. Test in Task 1.
3. A client export writes "No. of Employees" as text `11–50`; re-importing it must report no change. Test in Task 3.
4. A `combine` that names a column letter not in the table (e.g. after the header row changed) is a 400 on the PUT, not a silent skip. Test in Task 8.
5. An Excel float cell `37.0` reads as `{37, 37}`; `37.5` is `Invalid` (not a whole number). Test in Task 1.

---

## Part 1 — Employee ranges

### Task 1: `int_range` type and normalizer

**Files:**
- Modify: `helios-gateway/app/catalogue.py` (`DataType` literal, `employee_count` type and examples, `CATALOGUE_VERSION`)
- Modify: `helios-gateway/app/ingest/normalize.py` (new `int_range`, branch in `_one`)
- Test: `helios-gateway/tests/test_units.py`

**Interfaces:**
- Produces: `normalize.int_range(raw: Any) -> dict` returning `{"low": int | None, "high": int | None}`; raises `Invalid`. `normalize(CATALOGUE["employee_count"], raw)` routes to it.
- Produces: `normalize.range_text(value: dict) -> str` — `"37"`, `"11–50"`, `"10001+"`, `"up to 9"` (used by Tasks 3 and 4).

- [ ] **Step 1: Write the failing tests** in `test_units.py`:

```python
@pytest.mark.parametrize("raw, want", [
    ("37", (37, 37)), (37, (37, 37)), (37.0, (37, 37)),
    ("11-50", (11, 50)), ("11 – 50", (11, 50)), ("11 to 50", (11, 50)),
    ("1'001-5'000", (1001, 5000)), ("1,001-5,000", (1001, 5000)), ("1 001 – 5 000", (1001, 5000)),
    ("10001+", (10001, None)), ("10,000+", (10000, None)), (">10000", (10001, None)),
    ("<10", (None, 9)), ("up to 10", (None, 10)),
])
def test_int_range_reads(raw, want):
    assert normalize(CATALOGUE["employee_count"], raw) == {"low": want[0], "high": want[1]}

@pytest.mark.parametrize("raw", ["50-11", "a few", "37.5", 37.5, datetime(2026, 10, 1), "-", "11-"])
def test_int_range_rejects(raw):
    with pytest.raises(Invalid):
        normalize(CATALOGUE["employee_count"], raw)

def test_int_range_rejects_excel_date_with_hint():
    with pytest.raises(Invalid, match="date"):
        normalize(CATALOGUE["employee_count"], datetime(2026, 10, 1))

@pytest.mark.parametrize("value, text", [
    ({"low": 37, "high": 37}, "37"), ({"low": 11, "high": 50}, "11–50"),
    ({"low": 10001, "high": None}, "10001+"), ({"low": None, "high": 9}, "up to 9"),
])
def test_range_text(value, text):
    assert range_text(value) == text
```

- [ ] **Step 2: Run them, expect FAIL** (`int_range` unsupported / `range_text` missing): `uv run pytest tests/test_units.py -k "int_range or range_text" -v`

- [ ] **Step 3: Implement.** Add `"int_range"` to `DataType`; `employee_count` type `"int_range"`, description "Number of employees as a figure or a band (e.g. 11-50, 10001+).", examples `("200", "11-50")`; bump `CATALOGUE_VERSION`. In `normalize.py`, `int_range(raw)`: datetimes/dates raise `Invalid("looks like a date — Excel may have turned a range like 1-10 into a date")`; numbers must be whole; text forms as in the tests (numbers through the existing `parse_number`; `>n` → low n+1, `<n` → high n-1, `n+` → low n, `up to n` → high n); `low > high` raises. `range_text` as in the tests.

- [ ] **Step 4: Run the tests, expect PASS.** Then `./scripts/check.sh`; fix what breaks because `employee_count` is no longer an int (e.g. `tests/test_corpus.py:108` expects `{"low": 5400, "high": 5400}` now — later tasks own the readers, so only fix tests that fail from the type change itself).

- [ ] **Step 5: Commit** — `feat(gateway): int_range type; employees read as a range`

### Task 2: Migration, search index and overlap filter

**Files:**
- Create: `helios-gateway/migrations/versions/c3d4e5f6a7b8_employee_ranges.py` (`down_revision = "b8c9d0e1f2a3"`)
- Modify: `helios-gateway/app/models.py` (`CompanySearch.employees` → `employees_low`, `employees_high`, both `BigInteger`, nullable)
- Modify: `helios-gateway/app/search.py` (row query, `SORT_COLUMNS["employees"]`, `Filters.where` employees block)
- Test: `helios-gateway/tests/test_migration.py`, `helios-gateway/tests/test_search.py`

**Interfaces:**
- Consumes: the value shape from Task 1.
- Produces: `company_search.employees_low`, `company_search.employees_high`; search items carry `employees_low` / `employees_high` wherever they carried `employees`.

- [ ] **Step 1: Write the failing tests.**
  - `test_migration.py::test_employee_ranges_migration`: seed (at the previous head) one `employee_count` observation `{"v": 200}`, one list-only `list_entry_states.data["employee_count"]` = `200`, and one `list_versions.corpus_edits` entry `{"field": "employee_count", "old": 150, "new": 200}`; upgrade; assert `{"v": {"low": 200, "high": 200}}`, `{"low": 200, "high": 200}`, and old/new as ranges; the company's `company_search` row has `employees_low == employees_high == 200`. (Note: `list_versions.changes` is a count, not values; leave it.)
  - `test_search.py::test_employees_filter_overlaps`: companies with ranges 11–50, 51–200, 201–500, 10001+ (open), up to 9, and none. Filter 50–200 → {11–50, 51–200}; min 5000 → {10001+}; max 10 → {up to 9}; `include_missing` adds the one without a figure and nothing else.
  - `test_search.py::test_sort_by_employees`: biggest first by low bound, null low sorting as 0 (up to 9 last among those with a figure).

- [ ] **Step 2: Run them, expect FAIL.**

- [ ] **Step 3: Implement.** Migration in frozen SQL: `jsonb_set` for numeric `v` on `employee_count` observations; list states `data->'employee_count'` numeric → object; `corpus_edits` elements with `field = 'employee_count'` rewrite numeric `old`/`new`; drop `ix_company_search_employees` and `employees`, add the two columns with an index on `employees_low`; backfill every `company_search` row with this migration's own frozen copy of the row query (copy from `app/search.py` after your change, as `f9a0b1c2d3e4` did). Downgrade: narrow (ranges with low = high back to numbers; others to `low`, documented). Search: row query reads `(o.value->'v'->>'low')::bigint` and `->>'high'`; filter uses the overlap condition from Global Constraints with the existing `_range(...)` include-missing wrapper testing `low IS NULL AND high IS NULL` as missing; sort key `coalesce(employees_low, 0)`.

- [ ] **Step 4: Run the tests, expect PASS;** `./scripts/check.sh`.

- [ ] **Step 5: Commit** — `feat(gateway): migrate employees to ranges; overlap filter`

### Task 3: Exports and round-trip comparison

**Files:**
- Modify: `helios-gateway/app/exports.py` (`excel_value`, `_canon`)
- Test: `helios-gateway/tests/test_list_import.py`, `helios-gateway/tests/test_units.py`

**Interfaces:**
- Consumes: `normalize.range_text` (Task 1).
- Produces: `excel_value({"low": n, "high": n}, "int_range") == (n, "#,##0")`; any other range → `(range_text(v), None)`. `same("11-50", "11–50") is True`; `same(37, "37") is True`; `same("11-50", "11-60") is False`.

- [ ] **Step 1: Write the failing tests.** Units for `excel_value` and `same` as in Interfaces. `test_list_import.py::test_reimport_ranges_no_changes`: a list with a corpus company at 11–50 and one at exactly 37; full export and client export (`format=client`); re-import each untouched → report totals all 0 (Review Focus 3).

- [ ] **Step 2: Run them, expect FAIL.**

- [ ] **Step 3: Implement.** `excel_value`: dict branch with `"low" in value or "high" in value`. `_canon`: text matching a range (the same forms `int_range` reads, but only `a–b` / `a+` / `up to a`, not plain numbers or ISO dates) canonicalises to `("range", low, high)`; numbers keep their current canon, and an exact range written as a number compares as that number on both sides.

- [ ] **Step 4: Run, expect PASS;** `./scripts/check.sh`.

- [ ] **Step 5: Commit** — `feat(gateway): export and compare employee ranges`

### Task 4: Lists and the agent

**Files:**
- Modify: `helios-gateway/app/longlists.py` (corpus `set`: no edit when the normalized value equals the shown one)
- Modify: `helios-gateway/app/agent/tools.py` (`_TYPE_HINTS`, text for ranges in `_company_snapshot`, `read_list` values, `corpus_search` results)
- Modify: `helios-gateway/app/agent/prompt.md`, `helios-gateway/app/agent/skills/build_list.md` (one sentence each)
- Test: `helios-gateway/tests/test_longlists.py`, `helios-gateway/tests/test_agent.py`

**Interfaces:**
- Consumes: `normalize.range_text`; search items' `employees_low`/`employees_high` (Task 2).
- Produces: `tools.agent_value(value: Any) -> Any` — a range dict becomes `range_text(value)`, anything else unchanged; applied to every value the agent reads.

- [ ] **Step 1: Write the failing tests.**
  - `test_longlists.py::test_set_range_text_same_as_shown_is_no_change`: corpus company shown 11–50; `set` employee_count "11–50" → `ListError`/409 "Nothing changed" (no manual observation). `set` "37" → a corpus edit with `old {"low": 11, "high": 50}`, `new {"low": 37, "high": 37}`.
  - `test_longlists.py::test_list_only_row_takes_range`: list-only row, `set` "50-200" → table cell value `{"low": 50, "high": 200}`.
  - `test_agent.py::test_agent_sees_ranges_as_text`: scripted model calls `read_list` on a list with a 11–50 company; the tool result JSON holds `"11–50"`, no `"low"` key. Scripted `update_list` `set_cell` employee_count "50-200" on a list-only row succeeds.

- [ ] **Step 2: Run them, expect FAIL.**

- [ ] **Step 3: Implement.** `_TYPE_HINTS["int_range"] = "a number or a range, e.g. '250' or '50-200'"`. `agent_value` used where `read_list`, `_company_snapshot` and `corpus_search` build values. prompt.md (searching paragraph) and build_list.md (first pass): "Size filters keep every company whose employee range overlaps them (a company listed as 11–50 matches 50–200)." Equality in `longlists.set` compares normalized values (dict equality).

- [ ] **Step 4: Run, expect PASS;** `./scripts/check.sh`.

- [ ] **Step 5: Commit** — `feat(gateway): ranges on lists and for the agent`

### Task 5: Frontend display

**Files:**
- Modify: `helios-frontend/src/lib/corpus.ts` (`formatValue` range branch)
- Modify: `helios-frontend/src/lib/i18n.ts` ("up to {n}" → "bis {n}")
- Modify: wherever a cell editor pre-fills from a value (list table edit input): pre-fill the formatted range text, not JSON.

**Interfaces:**
- Consumes: read APIs return `{low, high}` (Tasks 2–4).
- Produces: `formatValue({low:11, high:50}) === "11–50"`, `{low:37,high:37}` → locale number (`37`), `{low:10001, high:null}` → `"10,001+"` / German `"10'001+"`, `{low:null, high:9}` → `t("up to {n}", {n: "9"})`.

- [ ] **Step 1: Implement** the branch before the `JSON.stringify` fallback (`"low" in v || "high" in v`), numbers via `toLocaleString(locale)`.
- [ ] **Step 2: Check** `npm run check` passes.
- [ ] **Step 3: Visual check** in the running app at 1440×900 (gateway seeded with a few test companies via an import of a small CSV with bands): Companies table Employees column, company page row and sources table, list table cell and its edit input. English only unless switching language is safe.
- [ ] **Step 4: Commit** — `feat(frontend): show employee ranges`

## Part 2 — Import transformations

### Task 6: Transform model and apply function

**Files:**
- Create: `helios-gateway/app/ingest/transforms.py`
- Test: `helios-gateway/tests/test_units.py`

**Interfaces:**
- Produces:
  - `class EmptyValues(BaseModel): kind: Literal["empty_values"]; values: list[str]` (≥1, each ≤60 chars)
  - `class Combine(BaseModel): kind: Literal["combine"]; columns: list[str]` (1–5 letters) `; separator: str = ", "` (≤5 chars)
  - `class Scale(BaseModel): kind: Literal["scale"]; factor: Literal[1000, 1000000]`
  - `Transform = Annotated[EmptyValues | Combine | Scale, Field(discriminator="kind")]`
  - `def apply(transforms: list[Transform], cells: list[Any], index: int, letters: dict[str, int]) -> Any` — the cell at `index` after the transforms (`None` when emptied); `cells` is the raw row, `letters` maps column letters to indexes.
  - `def check(transforms: list[Transform], letters: dict[str, int], own: str) -> None` — raises `ValueError(f"Column {L} isn't in this table.")` for an unknown letter or a column combining itself.

- [ ] **Step 1: Write the failing tests:** empty_values matches trimmed, case-insensitive ("0", " 0 ", "N/A" with values ["0","n/a"]) → None; combine `["F","H"]` on row `["switzerland", …, "zurich" (F), …, "zurich" (H)]` with own column A → `"switzerland, zurich, zurich"` in the order own-first-then-listed (spec: this column first); empty parts skipped; all parts empty → None; scale 1000 on `"12.5"` → `12500.0`, on `12` → `12000`, on `"EUR 3"` → `"EUR 3000"` (amount scaled, currency kept), on `"abc"` → unchanged (normalize reports the error); chained `[empty_values ["0"], scale 1000]` on "0" → None; `check` raises for unknown letter and self-combine.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (money scaling via the existing money parser: parse, multiply amount, write back as `f"{currency} {amount}"`).
- [ ] **Step 4: Run, expect PASS;** `./scripts/check.sh`.
- [ ] **Step 5: Commit** — `feat(gateway): import transforms model`

### Task 7: Fixture in the Switzerland list's shape

**Files:**
- Modify: `helios-gateway/tests/fixtures/make.py` (new `swiss_business_list.csv`, ~300 fictional rows, fixed seed)
- Create: `helios-gateway/tests/fixtures/swiss_business_list.csv` (generated)

**Interfaces:**
- Produces: a UTF-8-with-BOM CSV with headers `country, founded, id, industry, linkedin_url, locality, name, region, size, website`; all lower case; ~30% founded `"0"`; size bands `1-10 … 10001+`; ~15% empty website; some empty locality/region; accented names (é, ü, à, è); fictional names only.

- [ ] **Step 1:** Add the generator and run `uv run python -m tests.fixtures.make`; check the file has the headers and ~300 rows.
- [ ] **Step 2: Commit** — `test(gateway): Switzerland-list-shaped fixture`

### Task 8: Mapping, tables PUT and preview

**Files:**
- Modify: `helios-gateway/app/ingest/mapping.py` (`ColumnMapping.transforms`, prompt, `apply`)
- Modify: `helios-gateway/app/main.py` (`ColumnEdit.transforms`, `edit_tables`, import detail preview)
- Modify: `helios-gateway/app/ingest/listdiff.py` (`premap` never sets transforms)
- Test: `helios-gateway/tests/test_units.py`, `helios-gateway/tests/test_flow.py`, `helios-gateway/tests/test_list_import.py`

**Interfaces:**
- Consumes: `transforms.Transform`, `transforms.check`, `transforms.apply` (Task 6).
- Produces: each table column dict carries `transforms: list[dict]` (default `[]`) and, in `GET /imports/{id}`, `samples_after: list[Any]` — the first three non-empty preview cells after transforms, only for columns with transforms.

- [ ] **Step 1: Write the failing tests.**
  - `mapping.apply` keeps valid transforms from the LLM answer and drops a transform that fails `check` (unknown letter) without dropping the column's field.
  - `test_flow.py::test_put_tables_with_transforms`: PUT a combine on the HQ column → GET shows `transforms` and `samples_after` like `"zurich, zurich, switzerland"`; PUT a combine naming column `"Z"` → 400 "Column Z isn't in this table." (Review Focus 4); changing the header row keeps transforms whose letters still exist and 400s on the next PUT otherwise.
  - `test_list_import.py`: a verified Helios export's premapped columns have `transforms == []` and a PUT adding one to it → 400 "Transformations don't apply to a Helios export.".
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement.** System prompt adds a short block: the three transforms, one example each (`empty_values` for "0" meaning unknown; `combine` for city/region/country split over columns, put on the column mapped to the location data point; `scale` for "in thousands" headers), "only when the samples show the need". `ColumnMapping.transforms: list[Transform] = []`; invalid ones dropped in `apply` (validate each item separately so one bad transform doesn't drop the rest). `edit_tables` validates with `check`, stores dicts (`model_dump()`), keeps them across geometry refresh.
- [ ] **Step 4: Run, expect PASS;** `./scripts/check.sh`.
- [ ] **Step 5: Commit** — `feat(gateway): transforms in mapping, tables and preview`

### Task 9: Apply transforms in the corpus report and the list diff

**Files:**
- Modify: `helios-gateway/app/ingest/report.py` (`_row`: raw cell through `transforms.apply` before `is_empty`/normalize; `cell["raw"]` stays the original text, add `cell["transformed"]` when it differs)
- Modify: `helios-gateway/app/ingest/listdiff.py` (row cell extraction at the `cells = [...]` comprehension and `_company_values`)
- Test: `helios-gateway/tests/test_flow.py`, `helios-gateway/tests/test_list_import.py`

**Interfaces:**
- Consumes: column `transforms` (Task 8), `transforms.apply` (Task 6), the fixture (Task 7).

- [ ] **Step 1: Write the failing tests.**
  - `test_flow.py::test_swiss_list_imports_with_transforms`: upload `swiss_business_list.csv` as a corpus import (fake LLM), PUT a mapping: name→name, website→website, linkedin_url→linkedin_url, industry→sector, founded→founded with `empty_values ["0"]`, size→employee_count, locality→hq with `combine ["H", "A"]` (region, country letters as in the fixture), id and region and country unmapped. Build the report: zero errors; a row with locality+region+country has hq `{"city": …, "region": …, "country": "CH"}`; a row with only country has hq country CH; sizes are ranges; founded "0" rows have no founded value. Commit; a company's `employee_count` shows `{"low": 11, "high": 50}`.
  - `test_list_import.py::test_list_import_applies_transforms`: an outside file into a list with `empty_values ["0"]` on a custom new column and on founded → those cells are empty, not changes.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** (letters map from the table's columns).
- [ ] **Step 4: Run, expect PASS;** `./scripts/check.sh`.
- [ ] **Step 5: Commit** — `feat(gateway): apply import transforms in reports and list diffs`

### Task 10: Mapping screen chips, editor and preview

**Files:**
- Modify: `helios-frontend/src/lib/gateway.ts` (column type: `transforms`, `samples_after`)
- Modify: `helios-frontend/src/components/ImportModal.tsx` (`Mapping` rows, the `key` of `<Mapping>` includes transforms, `unchangedTables` carries them, PUT body includes them)
- Create: `helios-frontend/src/components/TransformEditor.tsx` (popover)
- Modify: `helios-frontend/src/lib/i18n.ts`

**Interfaces:**
- Consumes: `transforms`, `samples_after` from `GET /imports/{id}`; PUT `/imports/{id}/tables` accepts `transforms` per column (Task 8).
- Produces: chip labels (i18n keys): "Empty: {values}", "Combined with {columns}", "× 1,000" / "× 1,000,000"; editor actions "Add transformation", "Treat as empty", "Combine with columns", "Scale", "Remove".

- [ ] **Step 1: Implement.** Under each mapped row's dropdown: chips (`rounded-full`, `bg-subtle`, 12.5px) plus a small "+" that opens `TransformEditor` (popover rules). Treat as empty: comma-separated input. Combine: checkboxes of the table's other columns (letter + header) in order, separator input defaulting ", ". Scale: two options. Saving PUTs the tables like a field change. When a column has transforms, its three samples read `before → after` from `samples_after`.
- [ ] **Step 2:** `npm run check` passes.
- [ ] **Step 3: Visual check** at 1440×900 with the Task 7 fixture uploaded: chips, popover, before → after (`zurich` → `zurich, zurich, switzerland`), and that a 400 from the PUT shows the gateway's message like other errors.
- [ ] **Step 4: Commit** — `feat(frontend): transformations on the mapping screen`

### Task 11: Evals, new scenario, docs

**Files:**
- Create/modify: `helios-gateway/evals/scenarios/` (one scenario: list with banded sizes; user asks to keep buyers with 50–200 employees; expected keep/flag/drop by name: overlapping bands kept, 201–500 dropped, unknown kept and flagged)
- Modify: `helios-gateway/evals/history/*` (via `evals.history`)
- Modify: `helios-gateway/AGENTS.md`, `helios-frontend/AGENTS.md`

- [ ] **Step 1: Before/after evals.** `helios_scenarios`, 3 epochs, same agent and judge model and dataset, on a throwaway worktree of the branch's base commit (before) and on the branch (after). Record the earlier run first: `uv run python -m evals.history --note "before employee ranges"` then `--note "employee ranges and import transforms"`.
- [ ] **Step 2: Add the scenario** (reuses `filter_retention`), run it once on the branch, record it.
- [ ] **Step 3: Docs.** Gateway AGENTS.md: `int_range` and the value shape, overlap filter, export/compare rule, the migration, transforms (menu, where applied, never on exports, no code execution). Frontend AGENTS.md: range display, mapping chips and editor.
- [ ] **Step 4:** `./scripts/check.sh` and `npm run check`.
- [ ] **Step 5: Commit** — `docs: employee ranges and import transforms; eval history`
- [ ] **Step 6: Report** to the owner: before/after pass rate, judge mean, cost, chats × epochs, what the numbers can't show.
