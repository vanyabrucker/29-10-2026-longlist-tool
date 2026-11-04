"""Parsing, table detection, normalisation, matching and scoring without a
database or LLM."""

from datetime import date, timedelta
from pathlib import Path

import pytest

from app.catalogue import CATALOGUE
from app.ingest import detect, parse
from app.ingest.match import norm_name
from app.ingest.normalize import (
    Invalid,
    is_empty,
    money,
    normalize,
    parse_number,
    split_name,
    to_date,
)
from app.quality import score

FIXTURES = Path(__file__).parent / "fixtures"


def load(name: str):
    return parse.parse(name, (FIXTURES / name).read_bytes())


def test_password_protected_is_rejected():
    with pytest.raises(parse.ParseError, match="password-protected"):
        load("protected.xlsx")


def test_unsupported_type_is_rejected():
    with pytest.raises(parse.ParseError, match="Unsupported"):
        parse.parse("notes.docx", b"x")


def test_hidden_sheets_are_skipped_with_a_warning():
    sheets, warnings = load("internal_longlist.xlsx")
    assert [s.name for s in sheets] == ["Financial buyers", "Strategics"]
    assert any("Notes" in w for w in warnings)


def test_tables_skip_titles_and_totals_and_join_stacked_headers():
    sheets, _ = load("internal_longlist.xlsx")
    fin, strat = (detect.heuristic_tables(s)[0] for s in sheets)
    assert (fin["header_row"], fin["first_data_row"], fin["last_row"]) == (4, 5, 11)
    assert "Project Cedar" in fin["title"]
    headers = [c["header"] for c in strat["columns"]]
    assert "Financials / Revenue 2024" in headers
    assert strat["first_data_row"] == 4


def test_formulas_without_saved_results_are_found():
    sheets, _ = load("internal_longlist.xlsx")
    assert (5, 4) in sheets[1].formula_gaps  # E6 = E4*2, never calculated


def test_semicolon_csv_keeps_text_rows_as_data():
    sheets, _ = load("contacts.csv")
    t = detect.heuristic_tables(sheets[0])[0]
    assert (t["header_row"], t["first_data_row"]) == (1, 2)


@pytest.mark.parametrize("text,amount,currency", [
    ("€2.1B", 2.1e9, "EUR"),
    ("CHF 1,4 Mrd", 1.4e9, "CHF"),
    ("€ 410 Mio.", 410e6, "EUR"),
    ("2.1 bn EUR", 2.1e9, "EUR"),
    ("SEK 2.3bn", 2.3e9, "SEK"),
    ("1'250", 1250, None),
])
def test_money(text, amount, currency):
    assert money(text) == {"amount": pytest.approx(amount), "currency": currency}


def test_numbers_in_local_formats():
    assert parse_number("1'662") == 1662
    assert parse_number("1.662,5") == 1662.5
    assert parse_number("1,662") == 1662
    assert parse_number("2,5") == 2.5


def test_dates_keep_their_precision():
    assert to_date("12.08.2026") == {"date": "2026-08-12", "precision": "day"}
    assert to_date("Mar 2026") == {"date": "2026-03-01", "precision": "month"}
    assert to_date("2024") == {"date": "2024-01-01", "precision": "year"}
    assert to_date(46000)["precision"] == "day"  # Excel serial


def test_placeholders_are_empty():
    assert all(is_empty(v) for v in ("n/a", "Not disclosed", "-", "?", "  ", None))


def test_types():
    assert normalize(CATALOGUE["relevance_score"], 0.94) == 94
    assert normalize(CATALOGUE["relevance_score"], "91%") == 91
    assert normalize(CATALOGUE["website"], "https://www.bwk.de/") == "bwk.de"
    assert normalize(CATALOGUE["investor_type"], "Private Equity") == "PE"
    assert normalize(CATALOGUE["hq"], "Zürich, CH") == {
        "city": "Zürich", "region": None, "country": "CH"}
    assert normalize(CATALOGUE["acquisition_interest"], "ja") is True
    assert normalize(CATALOGUE["markets"], "DE; CH, Austria") == ["DE", "CH", "AT"]
    with pytest.raises(Invalid):
        normalize(CATALOGUE["investor_type"], "Unicorn Fund")


def test_names():
    assert split_name("Dr. Anna Muster") == ("Anna", "Muster")
    assert split_name("Muster, Max") == ("Max", "Muster")
    assert norm_name("BWK GmbH Unternehmensbeteiligungsgesellschaft") == "bwk"
    assert norm_name("Isarblick Capital Partners GmbH") == "isarblick capital partners"


def test_score_is_confidence_times_freshness():
    today = date.today()
    assert score(0.9, "name", today) == 90
    # AUM halves every 200 days.
    assert score(1.0, "aum", today - timedelta(days=200)) == 50
    # Undated values count as half fresh.
    assert score(0.8, "aum", None) == 40
    # Data points that don't go stale.
    assert score(0.7, "founded", today - timedelta(days=5000)) == 70
