"""Generate the sample files the tests import (run: uv run python -m
tests.fixtures.make). They mimic internal Helbling spreadsheets: title rows
above the header, a two-row merged header, formulas, duplicates, placeholders
like "n/a", a hidden sheet, a semicolon CSV and a password-protected copy."""

import csv
import io
import random
import re
import unicodedata
from pathlib import Path

from msoffcrypto.format.ooxml import OOXMLFile
from openpyxl import Workbook

HERE = Path(__file__).parent


def longlist() -> bytes:
    wb = Workbook()
    fin = wb.active
    fin.title = "Financial buyers"
    fin.append(["Project Cedar – buyer longlist"])
    fin.append(["Stand: 30.09.2026, vertraulich"])
    fin.append([])
    fin.append(["#", "Buyer", "Type", "Website", "HQ", "AUM", "Fit", "Rationale",
                "Contact", "E-Mail", "Position"])
    rows = [
        (1, "BWK GmbH Unternehmensbeteiligungsgesellschaft", "Private Equity",
         "https://www.bwk.de", "Stuttgart, DE", "Not disclosed", 0.94,
         "Long-standing Mittelstand investor", "Dr. Anna Muster", "anna.muster@bwk.de", "CEO"),
        (2, "Isarblick Capital Partners", "PE", "isarblick-capital.de", "Munich, Germany",
         "€2.1B", "91%", "Buy-and-build in IT services", "Muster, Max",
         "max.muster@isarblick-capital.de", "Head of Strategy"),
        (3, "Rheintal Growth Partners", "Growth Equity", "rheintal-growth.ch", "Zürich, CH",
         "CHF 1,4 Mrd", 86, "Growth investor in DACH", None, None, None),
        (4, "Alpen Family Holding", "Family Office", "alpenholding.ch", "Zug, Schweiz",
         "n/a", 70, "Long hold periods", "Lea Keller", "lea@alpenholding.ch", "CFO"),
        # Same company again (same website): a duplicate within the file.
        (5, "Isarblick Capital Partners GmbH", "PE", "www.isarblick-capital.de/",
         "Munich", "2.1 bn EUR", 90, "Second entry from another analyst",
         None, None, None),
        (6, "Nordlicht Ventures", "Venture Capital", "nordlicht.vc", "Hamburg, DE", "€300M",
         55, "Seed to Series B, outside scope", None, None, None),
        (7, "Bergmann Industrie Capital", "Unicorn Fund", "bergmann-cap.de", "Berlin, DE",
         "€900M", 63, "Type value our rules don't know", None, None, None),
    ]
    for r in rows:
        fin.append(r)
    fin.append(["Total", None, None, None, None, None, "=SUM(G5:G11)"])

    strat = wb.create_sheet("Strategics")
    strat.append(["Strategic buyers"])
    strat.append(["Company", "Country", "Employees", "Financials", None, "Interest"])
    strat.append([None, None, None, "Revenue 2024", "EBITDA 2024", None])
    strat.merge_cells("D2:E2")
    strat.append(["Nordwind Business Consulting AG", "Germany", "1'250", "€ 410 Mio.",
                  "€ 52 Mio.", "ja"])
    strat.append(["Helix IT Services Group", "NL", 5400, 1800000000, 210000000, "yes"])
    strat.append(["Polaris Supply Chain Solutions", "Sweden", "approx 900", "SEK 2.3bn",
                  "=E4*2", "?"])

    hidden = wb.create_sheet("Notes")
    hidden.append(["internal notes, not data"])
    hidden.sheet_state = "hidden"

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def contacts_csv() -> bytes:
    text = (
        "Firma;Vorname;Nachname;Funktion;E-Mail;Telefon;Letzter Kontakt\n"
        "BWK GmbH;Anna;Muster;Geschäftsführerin;anna.muster@bwk.de;+49 711 225576 0;12.08.2026\n"
        "Helix IT Services Group;Tom;Jansen;CFO;t.jansen@helix-it.nl;+31 20 555 0101;Mar 2026\n"
        "Nordwind Business Consulting AG;Petra;Lang;Leiterin M&A;petra.lang@nordwind.de;;\n"
    )
    return text.encode("utf-8-sig")


def contacts_no_role_csv() -> bytes:
    """Contacts with a name and email but no role column (title, function,
    primary): the import makes roles without facts of their own."""
    text = (
        "Firma;Vorname;Nachname;E-Mail\n"
        "Rollenlos Technik GmbH;Lea;Ohnetitel;lea.ohnetitel@rollenlos.de\n"
    )
    return text.encode("utf-8-sig")

SWISS_HEADER = ["country", "founded", "id", "industry", "linkedin_url", "locality",
                "name", "region", "size", "website"]
SWISS_SIZES = ["1-10", "11-50", "51-200", "201-500", "501-1000", "1001-5000",
               "5001-10000", "10001+"]
SWISS_STEMS = ["quantéa", "bärgtech", "lémanor", "tessaro", "sèvra", "brünnel",
               "helvetix", "brimlo", "sundrie", "tarnvel", "orbelin", "vastrel",
               "cristo", "ludorine", "fjellant", "novaraum", "aarequell", "kiesel",
               "hügelberg", "sonnatech"]
SWISS_WORDS = ["industrie", "systems", "solutions", "labs", "partners", "logistik",
               "engineering", "health", "finanz", "services", "werk", "digital"]
SWISS_FORMS = ["ag", "ag", "ag", "sa", "gmbh", "gmbh", "sàrl"]
SWISS_INDUSTRIES = ["industrial software", "medical devices", "precision engineering",
                    "food processing", "logistics services", "private banking",
                    "it consulting", "building materials", "pharmaceutical services",
                    "watch components", "packaging", "clean energy", "retail software",
                    "insurance brokerage", "machine tools", "biotech research"]
SWISS_PLACES = [("zürich", "zürich"), ("genève", "genève"), ("lausanne", "vaud"),
                ("basel", "basel-stadt"), ("zug", "zug"), ("bern", "bern"),
                ("lugano", "ticino"), ("yverdon-les-bains", "vaud"), ("fribourg", "fribourg"),
                ("neuchâtel", "neuchâtel"), ("schaffhausen", "schaffhausen"),
                ("sion", "valais"), ("chur", "graubünden"), ("luzern", "luzern"),
                ("aarau", "aargau"), ("st. gallen", "st. gallen"), ("winterthur", "zürich"),
                ("biel/bienne", "bern"), ("altdorf", "uri"), ("thun", "bern")]


def _slug(text: str) -> str:
    decomposed = unicodedata.normalize("NFKD", text)
    plain = "".join(c for c in decomposed if not unicodedata.combining(c))
    return re.sub(r"[^a-z0-9]+", "-", plain.lower()).strip("-")


def _swiss_row(name: str, founded: str, industry: str, locality: str, region: str,
               size: str, tld: str) -> list[str]:
    """One row. The website drops the legal form from the name; the id is the
    slug of the whole name, and the LinkedIn path uses the same slug."""
    slug = _slug(name)
    site = f"{_slug(' '.join(name.split()[:-1]))}.{tld}" if tld else ""
    return ["switzerland", founded, slug, industry, f"linkedin.com/company/{slug}",
            locality, name, region, size, site]


def swiss_business_list() -> bytes:
    """A fictional list shaped like a Swiss business export (lower case, no
    schemes on URLs, accents). Fixed seed, so the file is reproducible. The
    first three rows cover the location cases the tests rely on."""
    rng = random.Random(20261124)
    rows = [
        _swiss_row("quantéa solutions ag", "1987", "industrial software", "zürich",
                   "zürich", "201-500", "ch"),
        _swiss_row("bärgtech labs gmbh", "0", "medical devices", "", "",
                   "11-50", "ch"),
        _swiss_row("lémanor finance sa", "2003", "private banking", "genève", "",
                   "51-200", "ch"),
    ]
    used = {row[6] for row in rows}
    while len(rows) < 300:
        stem = rng.choice(SWISS_STEMS)
        if rng.random() < 0.5:
            stem = f"{stem} {rng.choice(SWISS_WORDS)}"
        name = f"{stem} {rng.choice(SWISS_FORMS)}"
        if name in used:
            continue
        used.add(name)
        founded = "0" if rng.random() < 0.3 else str(rng.randint(1900, 2024))
        locality, region = rng.choice(SWISS_PLACES)
        if rng.random() < 0.08:
            locality = ""
        if rng.random() < 0.10:
            region = ""
        tld = "" if rng.random() < 0.15 else rng.choice(["ch", "com"])
        rows.append(_swiss_row(name, founded, rng.choice(SWISS_INDUSTRIES), locality,
                               region, rng.choice(SWISS_SIZES), tld))

    buf = io.StringIO()
    writer = csv.writer(buf, quoting=csv.QUOTE_ALL, lineterminator="\n")
    writer.writerow(SWISS_HEADER)
    writer.writerows(rows)
    return buf.getvalue().encode("utf-8-sig")


def encrypted(data: bytes) -> bytes:
    out = io.BytesIO()
    OOXMLFile(io.BytesIO(data)).encrypt("secret", out)
    return out.getvalue()


def main() -> None:
    data = longlist()
    (HERE / "internal_longlist.xlsx").write_bytes(data)
    (HERE / "contacts.csv").write_bytes(contacts_csv())
    (HERE / "contacts_no_role.csv").write_bytes(contacts_no_role_csv())
    (HERE / "protected.xlsx").write_bytes(encrypted(data))
    (HERE / "swiss_business_list.csv").write_bytes(swiss_business_list())
    print("written:", *sorted(p.name for p in HERE.iterdir() if p.suffix != ".py"))


if __name__ == "__main__":
    main()
