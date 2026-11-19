# Helios — repository overview

Two apps:

- `helios-frontend/` — the Next.js app (demo UI, dev import UI). Notes: `helios-frontend/AGENTS.md`.
- `helios-gateway/` — the Python FastAPI service: Excel ingestion into the master database, and its read API. Notes: `helios-gateway/AGENTS.md`.

Run each from its own folder. Secrets live in each app's `.env` (never committed).

## New dependencies need human sign-off

Never add a dependency (npm package, Python package, Docker image, Postgres extension, or any other external library or service) without asking a human first and getting a clear yes. Say what it is, why it's needed and what the alternative is (usually the standard library or what we already have). This covers dev dependencies too. An approval covers that one dependency, not later ones.

## No fallbacks unless asked

Don't build fallbacks (a default value, a second source for a setting, a quiet retry with something else, a degraded mode) unless explicitly requested. If something required is missing or fails, fail fast with a clear error instead.

## Before every commit

There are no PRs or CI yet, so a commit is the gate: run the checks of every app the commit touches, and commit only when they pass.

- `helios-gateway/`: `./scripts/check.sh` (ruff, then pytest; needs `docker compose up -d`).
- `helios-frontend/`: `npm run check` (eslint, then `tsc --noEmit`); UI changes also get the visual check described in its notes.

Fix every ruff and lint error, including ones that were already there; never commit around them. A `# noqa` or `eslint-disable` is only for a deliberate exception and names the reason on the same line (e.g. `# noqa: BLE001 - any parser error on untrusted bytes`). Never skip hooks or checks to get a commit through.
