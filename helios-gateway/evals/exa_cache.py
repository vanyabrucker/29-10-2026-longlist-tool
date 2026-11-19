"""Web research for replays: Exa results cached by query, so compared models
see the same web.

Modes:
- `record` (default): answer from the cache; on a miss, search Exa live and
  store the result. The first model to ask a query pays for it, every later
  run gets the same hits.
- `replay`: cache only. A miss is a tool error ("not in the eval's web
  cache"), which counts as a tool error for that run.
- `live`: always search Exa, never store (to see today's web).

The cache is seeded from the original chats' own searches when the dataset is
exported. Keys are the query with case and spacing normalised; a cached
result with more hits than asked for is cut down, one with fewer is fetched
again in record mode.
"""

from __future__ import annotations

import json
import threading
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal

from evals.env import CACHE_DIR

Mode = Literal["record", "replay", "live"]
DEFAULT_PATH = CACHE_DIR / "exa.json"


def key(query: str) -> str:
    return " ".join(query.casefold().split())


class ExaCache:
    def __init__(self, path: Path = DEFAULT_PATH, mode: Mode = "record", live=None):
        if mode not in ("record", "replay", "live"):
            raise ValueError(f"Unknown web cache mode {mode!r}")
        self.path, self.mode = path, mode
        self._live = live
        self._lock = threading.Lock()
        self.hits = self.misses = 0
        self.entries: dict[str, dict[str, Any]] = (
            json.loads(path.read_text()) if path.is_file() else {})

    def live(self, query: str, num_results: int) -> list[dict[str, Any]]:
        if self._live is None:
            from app.agent.tools import _exa_search

            self._live = _exa_search
        return self._live(query, num_results)

    def search(self, query: str, num_results: int) -> list[dict[str, Any]]:
        if self.mode == "live":
            return self.live(query, num_results)
        with self._lock:
            entry = self.entries.get(key(query))
        if entry and (len(entry["results"]) >= num_results or self.mode == "replay"):
            self.hits += 1
            return entry["results"][:num_results]
        if self.mode == "replay":
            self.misses += 1
            raise LookupError(f"not in the eval's web cache (replay mode): {query!r}")
        self.misses += 1
        results = self.live(query, num_results)
        self.store(query, results)
        return results

    def store(self, query: str, results: list[dict[str, Any]], *, save: bool = True) -> None:
        with self._lock:
            old = self.entries.get(key(query))
            if old and len(old["results"]) >= len(results):
                return
            self.entries[key(query)] = {
                "query": query, "results": results,
                "recorded_at": datetime.now(UTC).isoformat(timespec="seconds")}
            if save:
                self._save()

    def save(self) -> None:
        with self._lock:
            self._save()

    def _save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.entries, indent=1, ensure_ascii=False))
        tmp.replace(self.path)
