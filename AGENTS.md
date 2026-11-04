# Helios — repository overview

Two apps:

- `helios-frontend/` — the Next.js app (demo UI, dev import UI). Notes: `helios-frontend/AGENTS.md`.
- `helios-gateway/` — the Python FastAPI service: Excel ingestion into the master database, and its read API. Notes: `helios-gateway/AGENTS.md`.

Run each from its own folder. Secrets live in each app's `.env` (never committed).
