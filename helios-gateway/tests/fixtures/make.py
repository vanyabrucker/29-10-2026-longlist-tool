"""Generate the sample files the tests import (run: uv run python -m
tests.fixtures.make). They mimic internal Helbling spreadsheets: title rows
above the header, a two-row merged header, formulas, duplicates, placeholders
like "n/a", a hidden sheet, a semicolon CSV and a password-protected copy."""

import io
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
    print("written:", *sorted(p.name for p in HERE.iterdir() if p.suffix != ".py"))


if __name__ == "__main__":
    main()
