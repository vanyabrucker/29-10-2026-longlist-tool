#!/bin/sh
# Everything that must pass before a commit. Needs `docker compose up -d`.
set -e
cd "$(dirname "$0")/.."
echo "→ ruff"
uv run ruff check .
echo "→ pytest"
uv run pytest
