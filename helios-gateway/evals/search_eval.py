"""Recall@10 of company search on `evals/search_queries.json`, against the
configured database seeded with `evals.seed --embed`:

- **text only:** the whole search as one keyword query, no filters (what the
  agent did before filters existed);
- **keyword + filters:** plain-words query, keyword retrieval only;
- **hybrid + filters:** the same with semantic retrieval fused in.

Recall@10 = expected companies in the top 10 / min(10, expected).

    uv run python -m evals.search_eval [--verbose]
"""

import argparse
import json
from pathlib import Path

from sqlalchemy import text

from app import search
from app.db import SessionLocal
from app.regions import countries

CASES = Path(__file__).with_name("search_queries.json")
K = 10


def recall(found: list[str], expected: list[str]) -> float:
    return len(set(found[:K]) & set(expected)) / min(K, len(expected))


def filters_of(spec: dict) -> search.Filters:
    """A case's filters (tool-style: countries plus regions) as search.Filters."""
    spec = dict(spec)
    places = countries(spec.pop("countries", []), spec.pop("regions", []))
    return search.Filters(countries=places, **{
        k: tuple(v) if isinstance(v, list) else v for k, v in spec.items()})


def run(session, query: str, filters: search.Filters, mode: search.Mode) -> list[str]:
    ids = search.search(session, query, "relevance", False, 0, K, filters, mode).ids
    names = dict(session.execute(text(
        "SELECT entity_id, name FROM company_search WHERE entity_id = ANY(:ids)"),
        {"ids": ids}).all())
    return [names[i] for i in ids]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    cases = json.loads(CASES.read_text())["cases"]
    columns = ("text only", "keyword + filters", "hybrid + filters")
    totals = [0.0, 0.0, 0.0]
    print(f"{'case':32} {'n':>3}  " + "  ".join(f"{c:>17}" for c in columns))
    with SessionLocal() as session:
        for case in cases:
            filters = filters_of(case["filters"])
            results = [
                run(session, case["as_text"], search.Filters(), "keyword"),
                run(session, case["query"], filters, "keyword"),
                run(session, case["query"], filters, "hybrid"),
            ]
            scores = [recall(r, case["expected"]) for r in results]
            totals = [t + s for t, s in zip(totals, scores, strict=True)]
            print(f"{case['id']:32} {len(case['expected']):>3}  "
                  + "  ".join(f"{s:>17.2f}" for s in scores))
            if args.verbose:
                wrong = [n for n in results[2] if n not in case["expected"]]
                if wrong:
                    print(f"    hybrid top {K}, not expected: {', '.join(wrong)}")
    n = len(cases)
    print(f"{'mean recall@10':32} {'':>3}  "
          + "  ".join(f"{t / n:>17.2f}" for t in totals))


if __name__ == "__main__":
    main()
