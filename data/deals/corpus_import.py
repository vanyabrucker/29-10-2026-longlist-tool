"""Build a corpus import sheet from the scraped deals.

Reads ``deals.jsonl`` (from ``scrape_deals.py``) and writes
``deal-companies-import.csv``: one row per company that is the target or a
buyer of a usable deal, deduplicated by name (case, punctuation and legal form
ignored). Upload it in Helios under Imports → "Into: Corpus".

Columns use headers the import mapping recognises (Company name, Website,
Registry ID, Headquarters, Description). Only the name is filled; add the
website or registry ID where you can, since that is what the importer matches
existing companies on (name alone only matches with the country, as
"likely"). The last column, "Deals (not imported)", says which deals each
company was in: set it to "Not imported" in the mapping step.

    python3 data/deals/corpus_import.py
    python3 -m doctest data/deals/corpus_import.py
"""

from __future__ import annotations

import csv
import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE / "deal-companies-import.csv"
HEADERS = ["Company name", "Website", "Registry ID", "Headquarters", "Description",
           "Deals (not imported)"]

_LEGAL = re.compile(
    r"\b(?:ag|sa|gmbh|ltd|limited|inc|llc|bv|b\.v|nv|n\.v|spa|s\.p\.a|ab|a/s|se|kg|kgaa|co|"
    r"holding|group|gruppe|plc|corp|corporation)\b\.?", re.I)


def key(name: str) -> str:
    """A name reduced for deduplication.

    >>> key("Avectris AG") == key("avectris")
    True
    >>> key("Netrics Group") == key("netrics AG")
    True
    """
    k = _LEGAL.sub(" ", name.lower())
    return re.sub(r"[^\w]+", "", k)


def buyers(name: str) -> list[str]:
    """The buyer companies named in a buyer field.

    >>> buyers("Forster Gruppe and Genossenschaft Migros Aare")
    ['Forster Gruppe', 'Genossenschaft Migros Aare']
    >>> buyers("management and Helvetica Capital AG")
    ['Helvetica Capital AG']
    >>> buyers("Coca-Cola HBC Northern Ireland, a subsidiary of Coca-Cola HBC")
    ['Coca-Cola HBC Northern Ireland']
    >>> buyers("Swiss Post, Swiss Post Solutions")
    ['Swiss Post Solutions']
    >>> buyers("Luxoft Holding, Inc")
    ['Luxoft Holding, Inc']
    """
    name = re.sub(r",\s+an?\s+(?:subsidiary|unit|division)\s+of\s+.+$", "", name)
    name = re.sub(r"^Swiss Post,\s+", "", name)
    parts = [p.strip() for p in re.split(r"\s+and\s+", name)]
    return [p for p in parts if p and not re.fullmatch(r"(?:the\s+)?management(?:\s+team)?", p, re.I)]


def main() -> None:
    companies: dict[str, dict[str, object]] = {}

    def add(name: str, note: str) -> None:
        row = companies.setdefault(key(name), {"name": name, "deals": []})
        row["deals"].append(note)  # type: ignore[union-attr]

    with (HERE / "deals.jsonl").open(encoding="utf-8") as f:
        for line in f:
            d = json.loads(line)
            if not d["usable"]:
                continue
            when = f" ({d['date']})" if d["date"] else ""
            deal = f"{d['target']} bought by {d['buyer']}{when}"
            add(d["target"], f"target: {deal}")
            for b in buyers(d["buyer"]):
                add(b, f"buyer: {deal}")

    rows = sorted(companies.values(), key=lambda r: str(r["name"]).lower())
    with OUT.open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.writer(f)
        w.writerow(HEADERS)
        for r in rows:
            w.writerow([r["name"], "", "", "", "", "; ".join(r["deals"])])  # type: ignore[arg-type]
    print(f"{len(rows)} companies → {OUT.relative_to(HERE.parent.parent)}")


if __name__ == "__main__":
    main()
