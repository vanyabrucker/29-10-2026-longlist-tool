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
    location,
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


def test_config_lists_every_problem():
    from app.config import Settings

    s = Settings(
        _env_file=None, deepseek_api_key=None, llm_api_key=None, s3_bucket=" ",
        agent_llm_provider="azure_foundry", azure_foundry_endpoint=None,
        azure_foundry_key=None, azure_foundry_deployment_name=None,
        agent_llm_base_url=None, agent_llm_model=None, agent_llm_api_key=None,
        exa_api_key=None, export_secret=None, azure_foundry_embedding_deployment_name=None,
        azure_foundry_embedding_key=None,
        embedding_dimensions=3072,
    )
    assert s.problems() == [
        "S3_BUCKET is set but empty.",
        "DEEPSEEK_API_KEY (or LLM_API_KEY) is missing.",
        "AZURE_FOUNDRY_ENDPOINT (or AGENT_LLM_BASE_URL) is missing.",
        "AZURE_FOUNDRY_KEY (or AGENT_LLM_API_KEY) is missing.",
        "AZURE_FOUNDRY_DEPLOYMENT_NAME (or AGENT_LLM_MODEL) is missing.",
        "AZURE_FOUNDRY_ENDPOINT (or EMBEDDING_BASE_URL) is missing for embeddings.",
        "AZURE_FOUNDRY_EMBEDDING_KEY (or EMBEDDING_API_KEY) is missing for embeddings.",
        ("AZURE_FOUNDRY_EMBEDDING_DEPLOYMENT_NAME (or EMBEDDING_MODEL) is missing: the "
         "name of a text-embedding-3-large deployment."),
        ("EMBEDDING_DIMENSIONS must be 1536 (the column size the migration "
         "created)."),
        "EXA_API_KEY is missing.",
        ("EXPORT_SECRET is missing (signs exported workbooks; any random string "
         "of 32+ characters)."),
    ]
    other = Settings(
        _env_file=None, llm_provider="ollama",
        agent_llm_provider="azure_foundry",
        azure_foundry_endpoint="https://example/openai/v1",
        azure_foundry_key="k", azure_foundry_deployment_name="m",
        exa_api_key="x", export_secret="short", embedding_provider="local",
    )
    assert other.problems() == [
        ("LLM_PROVIDER 'ollama' isn't built in, so it needs LLM_BASE_URL and "
         "LLM_MODEL."),
        ("EMBEDDING_PROVIDER 'local' needs EMBEDDING_BASE_URL and "
         "EMBEDDING_MODEL."),
        "EXPORT_SECRET is too short; use 32 characters or more.",
    ]
    ok = Settings(
        _env_file=None, llm_provider="ollama",
        llm_base_url="http://localhost:11434/v1", llm_model="llama3",
        agent_llm_provider="azure_foundry",
        azure_foundry_endpoint="https://example/openai/v1",
        azure_foundry_key="k", azure_foundry_deployment_name="m",
        exa_api_key="x", export_secret="x" * 32,
        azure_foundry_embedding_deployment_name="text-embedding-3-large",
    )
    assert ok.problems() == []

    # OpenRouter has no default model and its own key.
    router = {
        "_env_file": None, "llm_base_url": "http://localhost:11434/v1",
        "llm_model": "llama3", "llm_provider": "ollama",
        "agent_llm_provider": "openrouter", "agent_llm_model": None,
        "agent_llm_api_key": None, "agent_llm_base_url": None,
        "openrouter_api_key": None, "exa_api_key": "x",
        "export_secret": "x" * 32,
        "azure_foundry_endpoint": "https://example/openai/v1",
        "azure_foundry_embedding_key": "k",
        "azure_foundry_embedding_deployment_name": "text-embedding-3-large",
    }
    assert Settings(**router).problems() == [
        "OPENROUTER_API_KEY (or AGENT_LLM_API_KEY) is missing for the agent.",
        "AGENT_LLM_MODEL is missing for OPENROUTER (e.g. qwen/qwen3.8-27b).",
    ]
    fine = Settings(**{**router, "openrouter_api_key": "k",
                       "agent_llm_model": "qwen/qwen3.8-27b"})
    assert fine.problems() == []
    assert fine.agent_llm == ("https://openrouter.ai/api/v1", "qwen/qwen3.8-27b", "k",
                              "bearer")


def _chat(handler):
    """An OpenAIChat whose HTTP calls go to `handler` (no network)."""
    import httpx

    from app.llm import OpenAIChat

    chat = OpenAIChat(provider_name="test", base_url="http://llm.test/v1",
                      model="m", api_key="k", timeout=5)
    chat.client = httpx.Client(base_url="http://llm.test/v1",
                               transport=httpx.MockTransport(handler))
    return chat


def test_chat_stream_retries_rate_limits(monkeypatch):
    import httpx

    from app import llm

    monkeypatch.setattr(llm.time, "sleep", lambda _s: None)
    calls = []

    def handler(request):
        calls.append(request)
        if len(calls) < 3:
            return httpx.Response(429, headers={"retry-after": "1"},
                                  json={"error": {"code": "RateLimitReached"}})
        body = ('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'
                "data: [DONE]\n\n")
        return httpx.Response(200, text=body,
                              headers={"content-type": "text/event-stream"})

    events = list(_chat(handler).stream([{"role": "user", "content": "x"}]))
    assert len(calls) == 3
    assert [e.text for e in events if e.kind == "text_delta"] == ["Hi"]


def test_chat_stream_gives_up_with_a_plain_message(monkeypatch):
    import httpx

    from app import llm

    monkeypatch.setattr(llm.time, "sleep", lambda _s: None)
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(429, json={"error": "too many"})

    with pytest.raises(llm.LLMError) as caught:
        list(_chat(handler).stream([{"role": "user", "content": "x"}]))
    assert len(calls) == len(llm.RETRY_DELAYS) + 1
    assert caught.value.status == 429
    assert "rate limit" in caught.value.user_message
    assert "too many" not in caught.value.user_message


def test_bad_requests_are_not_retried(monkeypatch):
    import httpx

    from app import llm

    monkeypatch.setattr(llm.time, "sleep", lambda _s: None)
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(400, json={"error": "bad"})

    with pytest.raises(llm.LLMError):
        list(_chat(handler).stream([{"role": "user", "content": "x"}]))
    assert len(calls) == 1


def test_retry_delay_honours_the_providers_reset_time():
    import httpx

    from app import llm

    def response(**headers):
        return httpx.Response(429, headers=headers)

    assert llm.retry_delay(response(), 0) == llm.RETRY_DELAYS[0]
    assert llm.retry_delay(response(**{"x-ratelimit-reset-tokens": "42"}), 0) == 42
    assert llm.retry_delay(response(**{"retry-after-ms": "7500"}), 0) == 7.5
    assert llm.retry_delay(response(**{"retry-after": "600"}), 0) == llm.MAX_RETRY_AFTER


@pytest.mark.parametrize("text, city, country", [
    ("Chur", "Chur", None),  # fuzzy matching used to turn this into Barbados
    ("Zurich", "Zurich", None),
    ("Hamburg", "Hamburg", None),
    ("Cham, CH", "Cham", "CH"),
    ("Switzerland", None, "CH"),
    ("Zug, Switzerland", "Zug", "CH"),
])
def test_location_never_guesses_a_country(text, city, country):
    assert location(text) == {"city": city, "region": None, "country": country}


def test_citations_syntax():
    from app import citations

    ok = ("Revenue CHF 412m [[S&P Capital IQ | | Revenue CHF 412m, FY2024]] and two "
          "deals [[Web research | https://example.com/a | Bought Mecano AG | 2023]].")
    assert citations.check(ok) == ok
    assert citations.check("No markers at all.") == "No markers at all."
    c = citations.parse("Orbis | | Owner: Kessler Foundation")
    assert (c.source, c.url, c.evidence) == ("Orbis", "", "Owner: Kessler Foundation")
    # The evidence may hold a pipe; the url may not be anything but http(s).
    assert citations.parse("A | https://x.ch | a | b").evidence == "a | b"
    for bad in ("Only two | parts", " | | evidence", "A | ftp://x | e", "A | | ",
                "A | javascript:alert(1) | e"):
        with pytest.raises(ValueError):
            citations.parse(bad)
    with pytest.raises(ValueError, match="unclosed"):
        citations.check("Half written [[Orbis | | Revenue")


def test_entry_rejects_a_malformed_citation_with_its_path():
    from pydantic import ValidationError

    from app.agent.tools import Entry

    Entry.model_validate({"name": "Acme", "relevance_explanation":
                          "Big [[Orbis | | Revenue CHF 1m, FY2024]]."})
    with pytest.raises(ValidationError, match="relevance_explanation"):
        Entry.model_validate({"name": "Acme", "relevance_explanation": "Big [[Orbis]]."})
