"""Import the fictional corpus (`evals/corpus.py`) into the configured
database through the normal import flow (upload, mapping, report, commit),
so search rows and embeddings are built exactly as for a real import.

    uv run python -m evals.seed            # needs the gateway's .env
    uv run python -m evals.seed --embed    # and wait for every embedding
    uv run python -m evals.seed --embed-only   # just embed what's missing

Columns are mapped by their catalogue labels (no LLM call). The import is
one version by `corpus-seed@helbling.ch`, revertable like any other. Run it
on a development database only.
"""

import argparse
import sys
import time

from fastapi.testclient import TestClient

from evals.corpus import workbook

SEED_USER = "corpus-seed@helbling.ch"


def _map_by_label(monkeypatch_target) -> None:
    from app.catalogue import CATALOGUE
    from app.ingest import mapping

    labels = {p.label.lower(): p.key for p in CATALOGUE.values() if p.entity == "company"}

    def propose(table, rows, filename, feedback):
        cols = []
        for c in table["columns"]:
            header = c["header"].split(" / ")[-1].lower()
            header = header.removesuffix(" 2025")
            key = labels.get(header)
            cols.append(mapping.ColumnMapping(letter=c["letter"], field=key,
                                              confidence=1.0 if key else 0))
        return mapping.apply(table["columns"], mapping.TableMapping(columns=cols)), ""

    monkeypatch_target.propose = propose


def _wait(client: TestClient, import_id: str, status: str) -> dict:
    while True:
        d = client.get(f"/imports/{import_id}").json()
        if d["status"] == status:
            return d
        if d["status"] == "failed":
            sys.exit(f"Import failed: {d['error']}")
        time.sleep(0.5)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--embed", action="store_true",
                        help="embed every company before exiting")
    parser.add_argument("--embed-only", action="store_true",
                        help="don't import; embed companies that lack a vector")
    args = parser.parse_args()
    if args.embed_only:
        from app import embeddings

        print(f"Embedded {embeddings.embed_pending()} companies")
        return

    from app import auth, embeddings
    from app.ingest import mapping
    from app.main import app
    from app.models import User

    _map_by_label(mapping)
    app.dependency_overrides[auth.current_user] = lambda: User(
        email=SEED_USER, name="Corpus seed", role="dev", language="en")
    with TestClient(app) as client:
        r = client.post("/imports", files={"file": ("search_corpus.xlsx", workbook())},
                        data={"source_type": "internal", "allow_duplicate": "true"})
        r.raise_for_status()
        iid = r.json()["id"]
        _wait(client, iid, "mapping_review")
        client.post(f"/imports/{iid}/report").raise_for_status()
        report = _wait(client, iid, "report_review")["report"]
        print(f"Report: {report['totals']}")
        client.post(f"/imports/{iid}/commit").raise_for_status()
        done = _wait(client, iid, "committed")
        print(f"Committed as version {done['version_id']}")
    if args.embed:
        print(f"Embedded {embeddings.embed_pending()} companies")


if __name__ == "__main__":
    main()
