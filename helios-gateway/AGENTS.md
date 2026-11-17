# helios-gateway — project notes

Python FastAPI service that imports spreadsheets into the Helios master database and serves it. Used only by devs (the dev-only `/admin` area of `helios-frontend`). Prototype: synchronous design, no job queue.

## Run

```sh
docker compose up -d          # Postgres :5433, S3-compatible store :9010
uv sync
uv run alembic upgrade head   # schema + source types
uv run python -m app.seed_users  # team accounts; passwords → .seed-users.local
uv run uvicorn app.main:app --port 8010 --reload
uv run pytest                 # needs docker compose up; no LLM key needed
./scripts/check.sh            # ruff + pytest; run before every commit
uv run python -m tests.fixtures.make   # regenerate the sample files
```

`.env` (git-ignored) needs only `DEEPSEEK_API_KEY`; everything else defaults to the docker-compose services (see `.env.example`).

**Config must fail fast.** All settings live in `app/config.py` (`Settings`). Anything the server can't run without is checked in `Settings.problems()`, and `app/main.py` calls `config.check()` on import: startup exits with code 1 and one message listing every missing or invalid setting (no traceback). When you add a required setting, add its check there (and a case in `test_config_lists_every_problem`) rather than failing later at first use. Tools that don't serve requests (alembic, tests) don't run the check. Only config stops startup: a database or storage outage never does (the process stays up and readiness reports it).

**Health and version** (`app/health.py`, no gateway secret needed):
- `/health`: liveness, always `{"ok": true}`. It must stay instant and never depend on Postgres, storage or the LLM, so a platform never restarts the gateway over an outage it can't fix.
- `/health/ready`: `SELECT 1` on Postgres plus the schema revision, and `head_bucket` on storage, in parallel with a 2s timeout each. 200 with `{"db": "ok", "migrations": "ok", "storage": "ok"}`, otherwise 503 with the failing part as `down`/`behind` and the reason under `detail`. A missing bucket counts as ok (the first upload creates it). The local SeaweedFS accepts any credentials, so wrong S3 keys only show up against a real S3.
- The LLM is never health-checked: it costs money and fails on provider hiccups; a missing key is caught at startup.
- `/version`: package version (`pyproject.toml`), git commit and whether the gateway folder has uncommitted changes (`GIT_COMMIT` overrides both, for deployments without `.git`), catalogue version and migration head. MinIO no longer publishes community images, so SeaweedFS's S3 gateway stands in locally; any S3 service works.

## Decisions (agreed in the design session)

- **Fixed data model**, defined once in `app/catalogue.py` (data points with entity, type, options, description, synonyms, examples, half-life). The LLM maps against it; bump `CATALOGUE_VERSION` on changes. Entities: company, person, role (person at company), transaction, project_ref (children of a company), list_entry (a company on a longlist, holding relevance score/explanation). `sector`/`sub_sector` are free text until a fixed sector list is agreed.
- **Append-only observations**: every value is an `Observation` with source type, document, sheet/row/column, as-of date and version. Nothing is overwritten. The shown value per entity/field/fiscal year is the best **quality score** = source confidence × freshness (half-life per data point; undated counts half fresh; ties → newer version), kept in `current_values` and rebuilt after each change (`app/values.py`).
- **Source confidence** is fixed per source type (`source_types` table, seeded in the first migration).
- **Freshness date**: the import's as-of date, which the dev confirms (defaults to the file's last-modified date), never the upload date.
- **Versions**: each import is one global version; revert is a new version that marks that version's observations retracted (re-reverting re-applies). Any version can be reverted on its own. Original files stay in object storage.
- **Matching** (`app/ingest/match.py`): companies by registry/Capital IQ/Orbis ID or domain (certain), name without legal form + country (likely), fuzzy name ≥ 88 (suggestion only). People by email/LinkedIn (certain), name + company (likely). Duplicates within one file share one record.
- **LLM** (`app/llm.py`): one `complete_json` interface; `OpenAICompatible` covers DeepSeek and self-hosted servers. Switch with `LLM_PROVIDER` / `LLM_BASE_URL` / `LLM_MODEL` / `LLM_API_KEY`. Used for table detection (a heuristic proposes, the LLM corrects; heuristic stands if it fails), column mapping (headers + ≤ 8 samples per column, never whole files) and enum values the rules don't recognise.
- **Long steps** run in a background thread in the API process and write step/progress/ETA to the `imports` row, which the UI polls. A restart marks running imports failed.
- **One commit at a time** (Postgres advisory lock); if anything was committed since the report was built, the report is rebuilt and the dev reviews again.
- **Search** (`app/search.py`): Postgres only, no separate engine. `company_search` has one row per company with its shown name, website, sector, HQ, description, latest revenue and employees plus a weighted `tsvector` ('simple' config: name and website A, sector and HQ B, description C), GIN-indexed, with `pg_trgm` indexes on the name and website. `values.recompute` refreshes it, so it changes in the same transaction as every import commit, pin and revert. A query matches word prefixes (`isar cap` → `isar:* & cap:*`, only letters and digits pass, so input can't inject tsquery syntax), the website as typed, or a fuzzy trigram match on the name (typos); relevance = ts_rank + word similarity + a name-prefix bonus. `GET /companies?q=&sort=relevance|name|website|hq|sector|revenue|employees&dir=&offset=&limit=` filters, sorts and pages in SQL and returns `{total, offset, limit, items}`. Revenue sorts by amount regardless of currency (no FX yet). The migration backfills the table with its own frozen copy of the query.
- **Prioritizing a value** (`app/corpus.py`, `value_pins`): anyone signed in can prioritize one source of a data point over the quality score (`PUT /companies/{id}/pins` with field, period, observation_id) or hand it back to the score (`DELETE /companies/{id}/pins?field=&period=`). Pins are append-only events, each its own version (`kind = pin`, author = the user's email), so reverting it undoes it and the previous event decides again; an event without an observation removes the priority. `recompute` shows the newest live pin's observation if that observation is still live (reverting the import it came from hands the cell back to the score until re-applied); `current_values.pin_id` marks it. Both endpoints take the commit lock, so a pending import report goes stale and is rebuilt. `GET /companies/{id}` returns `cells` (per data point and period, catalogue order: shown value, score, level, confidence, freshness, as-of, `pinned` {by, name, at} and all live sources, the shown one first, each with label, category proprietary/internal/public, file/sheet/cell and its own score) plus the older `fields` (every observation, retracted ones too) for the admin view.
- **Scores are computed when read.** `current_values.score` is a snapshot from the last recompute and freshness decays daily, so the API scores shown values from source confidence and as-of date at request time. The level is Unknown when a value that goes stale has no as-of date. Note: internal files (0.7) sit right at the High threshold (70), so their values read Medium a day after their as-of date.
- **Auth** (`app/auth.py`): email + password (stdlib scrypt hashes) against `users`; `POST /auth/login` returns a session token (only its SHA-256 is stored in `auth_sessions`, 30 days), sent back as `Authorization: Bearer`. `GET/PATCH /me` for the profile (name, language). Reading endpoints need any signed-in user (`SignedIn`); the import area needs `users.role = dev` (`Dev`, 403 otherwise). Roles are a ladder, member < admin < dev, each holding the rights of the ones before it (`User.is_admin` / `User.is_dev`), and its acting user is that user's email. The optional `GATEWAY_SECRET` (`X-Gateway-Secret`) is still checked on every request. Accounts come from `app/seed_users.py` (the Helbling team; existing users keep their password, `--reset EMAIL` issues a new one) or from admins: `GET /users` (any signed-in user), `POST /users` (admin; email + role member/admin; the generated password is returned only in that response) and `DELETE /users/{id}` (admin; not yourself, not a higher role; their sessions go with them). There is no self sign-up.

## Import flow

`POST /imports` (upload; 409 for a file uploaded before unless `allow_duplicate`) → `analysing` (parse, detect tables, store raw rows, LLM mapping) → `mapping_review` (dev edits: `PUT /imports/{id}/tables`, settings `PATCH /imports/{id}`, free-text `POST /imports/{id}/feedback` re-runs the mapping) → `POST /imports/{id}/report` → `report_review` (duplicates, matches, errors, quality, wins/loses vs current values; per-row decisions `PUT /imports/{id}/decisions`: `new` / `skip` / an entity id / `dup:<row key>`, and `<row key>:person` for the contact) → `POST /imports/{id}/commit` → `committed`. Revert with `POST /versions/{id}/revert` (dev only; works on imports, pins and reverts).

Edge cases: password-protected files are rejected; formulas use Excel's saved result and formulas without one are flagged; hidden sheets are skipped with a warning; macros are never run; `.xlsx/.xlsm/.xls/.xlsb/.ods/.csv` (CSV delimiter and encoding sniffed); placeholders like "n/a" or "Not disclosed" are empty; values that can't be parsed are errors in the report, never guesses.

## Layout

- `app/main.py` — import and version API. `app/corpus.py` — companies read API and pins. `app/search.py` — company search index. `app/values.py` — shown values. `app/models.py` — tables. `app/catalogue.py` — data model.
- `app/ingest/` — `parse`, `detect`, `mapping`, `normalize`, `match`, `report`, `commit`, `runner`.
- `migrations/` — Alembic. `tests/` — unit tests and a full-flow test with a rule-based LLM stand-in; `tests/fixtures/make.py` builds the sample files.
