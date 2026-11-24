# Employee ranges and import transformations — design

Date: 2026-11-24. Status: approved by the owner.

## Why

The owner wants to import a free "Switzerland Business List" (99,871 companies,
CSV). Profiling it showed that our import model can't hold what such sources
say:

- Company size comes as a band ("1-10", "11-50", …, "10001+"). Employees is a
  single whole number today, so 99.6% of those cells would be errors.
- Exact headcounts are usually wrong anyway; the owner cares more about the
  bounds. Sources differ in what they give: LinkedIn and Orbis give bands,
  Capital IQ an exact figure, internal files rough estimates.
- Some columns need a small reshaping before they fit a data point: the
  location is split across three columns (country, region, locality) while
  Headquarters is one field, and "0" stands for "unknown" in Founded
  (32,286 rows).

Two changes, decided with the owner:

1. **Employees becomes a range** (one data point whose value has a lower and an
   upper bound; an exact figure is a range of one).
2. **The import mapping gets transformations**, picked from a fixed menu, never
   code written and run at import time.

They are independent; build 1 first (the CSV needs it most), then 2.

## Decisions made with the owner

- **One range data point (option B), not three competing fields.** Each
  source's answer stays whole; the best-scored source wins, as for every other
  value. No "sources disagree" flag and no merging of ranges across sources:
  "we simply decide based on data quality".
- **Transformations from a fixed menu**, suggested by the mapping LLM, shown on
  the mapping screen with a before/after preview, editable by the reviewer. No
  generated code is executed (an uploaded file could steer the LLM).

## Goals

1. Store, show, filter, sort, export and re-import employee ranges.
2. A transformation step per mapped column in imports, with a preview.
3. A fictional fixture in the Switzerland list's shape (a few hundred rows)
   imports with full headquarters (city, region, CH), size bands as ranges,
   and "0" in Founded as empty. Decided with the owner: no slicing or trial of
   the real file in this change; the owner handles the real file separately.

## Non-goals

- Revenue bands ("CHF 10–50m"). The range type is built so revenue could use it
  later; not in this change.
- Combining or narrowing ranges across sources; agreement indicators.
- A free-form expression or regex language for transformations.
- Large-file import fixes (paged review screen, bulk commit, the fuzzy match
  cost against a big corpus). Found in the same analysis; a separate change.
- The embedding model switch (separate, pending the owner's runtime choice).

## Anti-goals

- Executing code produced by the LLM, or any user-supplied code.
- A shown range assembled from different sources (e.g. low from one, high
  from another).
- Guessing: a value that can't be read stays an error in the report, as today.

## Approaches considered

- **A. Three data points** (exact, lower, upper), each competing on its own.
  Precedent: `ticket_size_min` / `ticket_size_max`. Rejected: the shown lower
  and upper bound can come from different sources ("51 to 10"), and no single
  source stands behind what is shown.
- **B. One range data point (chosen).** `{low, high}`; exact = low equals high;
  open-ended = high null. Coherent, traceable, fits the existing
  observation/quality model unchanged.
- For transformations: **LLM-written code** (rejected: remote code execution
  risk from untrusted files), **a regex/expression language** (rejected for now:
  hard to review, more than this needs), **a fixed menu (chosen)**.

## Part 1 — Employee ranges

### Data model

- New catalogue type **`int_range`**. `employee_count` becomes `int_range`
  (label stays "Employees"; key unchanged so mappings, lists and exports keep
  working). Bump `CATALOGUE_VERSION`.
- Value shape: `{"low": int | null, "high": int | null}`, with at least one
  bound set and `low <= high` when both are set.
  - `"37"` / `37` → `{low: 37, high: 37}`
  - `"11-50"`, `"11 – 50"`, `"11 to 50"` → `{low: 11, high: 50}`
  - `"10001+"`, `">10000"`, `"10,000+"` → `{low: 10001, high: null}` (for `>`,
    low is the number plus one; for `+`, the number itself)
  - `"<10"` → `{low: null, high: 9}`; `"up to 10"` → `{low: null, high: 10}`
  - thousands separators (`'`, `,`, space) as the number parser already accepts
  - anything else, or low > high → `Invalid` (an error in the report, as today)
- Quality, freshness, half-life, pins and revert are unchanged: the whole range
  is one observation.

### Migration

- Frozen-SQL Alembic migration: every `employee_count` observation with a
  numeric `v` becomes `{"low": n, "high": n}`, and so does every list-held
  `employee_count` value in `list_entry_states.data`. Recorded export cells
  stay as written (they hold what went into Excel, compared with `same()`).
- Rebuild `company_search` rows (the employees columns change, below), with the
  migration's own frozen copy of the row query, as earlier search migrations do.

### Search and filters

- `company_search` replaces `employees` with `employees_low` and
  `employees_high` (bigint, nullable).
- **Filter by overlap** (my call, in the spirit of "unknown is never
  excluded"): a company matches `employees_min..employees_max` when its range
  overlaps: `(high IS NULL OR high >= min) AND (low IS NULL OR low <= max)`.
  Example: "50–200" keeps 11–50 (50 is in both) and 51–200, not 201–500.
  `include_missing` keeps meaning "no figure at all".
- **Sort** by the low bound, falling back to the high bound (open low ends sort
  as 0); biggest first as today.
- API parameters, the agent's `corpus_search` fields and the frontend filter
  chip keep their names and inputs. The agent prompt and `build_list` skill get
  one sentence: size filters match any company whose range overlaps.

### Display

- Frontend formatting (`src/lib/corpus.ts` value formatting, the list table,
  company page, quality box, sources table): `37`, `11–50` (en dash),
  `10,001+`, and `up to 9` for a range with no low bound. Numbers use the
  locale formatter (Swiss `10'001+` in German). "up to {n}" is an i18n string.
- Editing a cell on a list accepts the same text forms as an import (one
  parser on the gateway; the frontend sends text).

### Lists, agent, exports

- Lists: corpus columns read the shown value as today; list-held values (rows
  not in the corpus) store the range shape. `apply_changes` `set` /
  `add_entry` parse text or numbers through the same normalizer.
- Agent: `_TYPE_HINTS["int_range"]` = "a number or a range, e.g. '250' or
  '50-200'". `read_list` and snapshots show ranges as text (`11–50`), never as
  JSON.
- Full export: an exact range is written as a number; any other range as text
  (`11–50`, `10001+`). Client export "No. of Employees" the same. The record
  keeps what was written, so a round-trip compares equal (`same()` extended:
  a range compares by parsed bounds, so "11-50" and "11–50" match).
- List import / corpus import read the same forms back through the normalizer.

### Tests

- Normalizer cases above, including errors and low > high.
- Migration on fixture observations and list states.
- Search: overlap filter (inside, partly overlapping, outside, open-ended,
  missing with and without `include_missing`), sort order.
- Export → re-import of a list with exact and band values makes no changes.
- Agent tool: setting `employee_count` to "50-200" on a list-only row.

## Part 2 — Import transformations

### Model

- Each mapped column (`imports` table spec, the same dicts `PUT
  /imports/{id}/tables` edits) gains `transforms: list[Transform]`, applied in
  order to the cell **before** normalizing. Default empty.
- The menu (a Pydantic discriminated union, validated on the PUT and on the
  LLM's answer):
  1. **`empty_values`** `{values: [str]}`: these exact values (trimmed,
     case-insensitive) count as empty. For Founded "0".
  2. **`combine`** `{columns: [letter], separator: str}`: the cell becomes this
     column's value joined with the named columns' values (empty parts
     skipped), in the order given with this column first. For Headquarters:
     locality + region + country → `zurich, zurich, switzerland`, which the
     location parser already reads as city, region, country. Combined columns
     may still be mapped themselves or left out.
  3. **`scale`** `{factor: 1000 | 1000000}`: multiply a number (money keeps its
     currency). For files "in thousands"/"in millions" when the cells carry no
     unit.
- No regex, split or free expressions in this change (YAGNI; add to the menu
  when a real file needs it).

### Mapping LLM

- `ColumnMapping` gains `transforms` (same union, default `[]`). The system
  prompt describes the three transforms with one example each and says to use
  them only when the samples show the need. Invalid transforms in the answer
  are dropped (as unknown keys are today), not repaired.
- `combine` makes "each key at most one column" hold: the Headquarters key sits
  on one column, which pulls in the others.
- Verified Helios exports (`premap`) never get transforms.

### Mapping screen (frontend, `ImportModal.tsx`)

- Each mapped row shows its transforms as small chips under the dropdown
  ("Empty: 0", "Combined with F, H", "× 1,000"), editable in a popover
  (popover rules): add, remove, edit values / pick columns / factor.
- The three sample values show **before → after** whenever the column has
  transforms, so the reviewer sees `zurich` → `zurich, zurich, switzerland`.
- Changing transforms is a mapping change: the report is rebuilt as today.

### Report and commit

- `report._row` applies a column's transforms to the raw cell before
  `normalize`; the review shows the raw cell and the result, as for other
  normalized values. Errors name the transformed value.
- Provenance: the observation keeps the original column letter and cell (the
  mapped column), as today; the transform list is stored on the import (it is
  in the table spec), so it's traceable.

### Tests

- Each transform on its own and chained; combine with empty parts; scale on
  plain numbers and on money.
- LLM answer validation drops invalid transforms.
- PUT with transforms round-trips; report rebuild uses them.
- Fixture: a small slice of the Switzerland list shape (fictional rows) maps
  to full HQ, ranges and empty Founded with no errors.

## Harness and evals

Part 1 touches the agent's tools (type hint, read_list display, corpus_search
filter meaning) and the prompt/skill text, so per the root AGENTS.md: run
`helios_scenarios` (3 epochs) before and after, record both with
`evals.history`, and report. No scorer checks size ranges; say so and propose
one (a scenario with banded sizes and a size filter) if the change warrants.

## Calls made after the builder check (my calls; correct me)

- **API contract:** every read API returns `employee_count` as the object
  `{low, high}` (company cells and fields, list `table()` cells, versions and
  diffs); clients format it. `tests/test_corpus.py` and the frontend types
  change accordingly. The agent alone gets text (`11–50`).
- **Old shapes:** the migration rewrites every stored employee value, so no
  reader handles a bare number afterwards: observations, `list_entry_states.data` and
  `list_versions.corpus_edits` (`list_versions.changes` is only a count). Only
  `list_export_cells` keeps what was written to Excel.
- **What counts as a change:** two ranges are equal when both bounds are equal.
  Retyping "11-50" as "11–50" is no change; narrowing 37 to 11–50, or the
  reverse, is a change (on a list edit: a manual observation and pin, as today).
- **Half-open ranges** count as having a figure (`include_missing` is only for
  no value at all), and pass the overlap filter on their open side. "up to 9"
  sorts with 0–9.
- **`combine` details:** separator defaults to ", "; empty parts are skipped;
  the combining column is the one that carries the data point, so "each key at
  most one column" still holds; a component column may also be mapped to a
  *different* data point (e.g. region to nothing, country to Markets), never to
  the same one. Unit tests cover rows with only a country, only a locality, and
  locality + region without country, and accept what `location()` gives.
- **List imports too:** transforms apply wherever the mapping step runs: corpus
  imports and list imports of outside files, including columns mapped to a new
  custom column. Verified Helios exports never get transforms. (Same modal,
  same table spec; corpus-only would mean redoing the list diff later.)
- **Source of the CSV:** not part of this design; the importer picks it in the
  mapping step's "Where is this data from?" (e.g. Other, 50%, or Grasp, 30%,
  if it should never beat curated sources).
- **Evals:** the plan ends by adding a scenario with banded sizes and a size
  filter (the agent keeps overlapping companies), after the before/after run.

## Left to the builder

- Exact parser regexes and the en dash/`to` variants beyond those listed.
- Component split of the transform popover.
- Whether `int_range` display lives in `corpus.ts` or a small shared helper.
