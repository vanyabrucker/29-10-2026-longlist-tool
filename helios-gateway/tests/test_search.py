"""Search internals on hand-made search rows: revenue ranges across
currencies, sector words, ranking tiers and fusion, re-embedding only on text
changes, and the keyword fallback when the embedder fails."""

import uuid

import pytest
from sqlalchemy import text

from tests.conftest import FAKE_EMBEDDER, clear_corpus

ROWS = [
    # name, sector, sub_sector, country, revenue, currency, employees, description
    ("Alpha Medtech", "Healthcare", "Medical devices", "DE", 80e6, "EUR", 400,
     "Contract manufacturer of medical devices and implants"),
    ("Beta Präzision", "Industrials", "Precision engineering", "CH", 60e6, "CHF", 250,
     "Precision machining for medical device makers"),
    ("Gamma Capital", "Financial services", "Private equity", "DE", None, None, 25,
     "Mid-market buyout fund investing in Mittelstand companies"),
    ("Delta IT", "IT Services", "SAP consulting", "AT", 30e6, "USD", 180,
     "SAP S/4HANA consulting and supply chain software"),
    ("Capitalis Holding", "Real estate", None, "US", 5e9, "JPY", None,
     "Office property investor"),
]


@pytest.fixture
def rows(database, monkeypatch):
    from app import search

    # The margin is tuned for text-embedding-3; the word-hashing fake spreads
    # similarities much wider.
    monkeypatch.setattr(search, "VECTOR_MARGIN", 0.4)
    from app.db import session_scope

    clear_corpus()
    ids = {}
    with session_scope() as session:
        session.execute(text("INSERT INTO versions (id, kind, author, message, counts) "
                             "VALUES (1, 'import', 't', 't', '{}')"))
        for name, sector, sub, country, revenue, cur, emp, desc in ROWS:
            ids[name] = i = uuid.uuid4()
            session.execute(text("INSERT INTO entities (id, kind, created_version_id) "
                                 "VALUES (:id, 'company', 1)"), {"id": i})
            session.execute(text(
                "INSERT INTO company_search (entity_id, name, sector, sub_sector, country,"
                " revenue, revenue_currency, employees, description, embed_text, document)"
                " VALUES (:id, :n, :s, :ss, :c, :r, :cur, :e, :d, :et,"
                " to_tsvector('simple', :n || ' ' || coalesce(:s, '') || ' ' || :d))"),
                {"id": i, "n": name, "s": sector, "ss": sub, "c": country, "r": revenue,
                 "cur": cur, "e": emp, "d": desc, "et": f"{name}\n{sector}\n{desc}"})
        search.embeddings.mark(session)  # embedded after this commit
    return ids


def run(**kw):
    from app import search
    from app.db import session_scope

    q = kw.pop("q", None)
    mode = kw.pop("mode", "hybrid")
    with session_scope() as session:
        found = search.search(session, q, "relevance", False, 0, 50,
                              search.Filters(**kw), mode)
        names = dict(session.execute(text(
            "SELECT entity_id, name FROM company_search")).all())
    return [names[i] for i in found.ids], found


def test_revenue_ranges_compare_across_currencies(rows):
    # 60m CHF ≈ 64m EUR, 30m USD ≈ 28m EUR; JPY 5bn ≈ 31m EUR.
    assert run(revenue_min_m=50)[0] == ["Alpha Medtech", "Beta Präzision"]
    assert run(revenue_min_m=50, revenue_currency="CHF")[0] == [
        "Alpha Medtech", "Beta Präzision"]
    assert run(revenue_max_m=29)[0] == ["Delta IT"]
    # Without the figure, a company only passes with include_missing.
    assert "Gamma Capital" in run(revenue_max_m=29, include_missing=True)[0]


def test_sector_matches_whole_words(rows):
    assert run(sectors=("IT services",))[0] == ["Delta IT"]
    # "capital" isn't a word of "Capitalis"; "medical devices" is a sub-sector.
    assert run(sectors=("IT",))[0] == ["Delta IT"]
    assert run(sectors=("medical devices", "private equity"))[0] == [
        "Alpha Medtech", "Gamma Capital"]


def test_hybrid_finds_what_keywords_miss(rows):
    q = "medical device contract manufacturing"
    keyword, _ = run(q=q, mode="keyword")
    assert keyword == []  # every word must match
    hybrid, found = run(q=q)
    assert found.mode == "hybrid"
    assert hybrid[0] == "Alpha Medtech"
    assert "Beta Präzision" in hybrid and "Capitalis Holding" not in hybrid
    assert found.found_by[rows["Alpha Medtech"]] == ["vector"]
    # Filters apply to the semantic side too.
    assert run(q=q, countries=("CH",))[0] == ["Beta Präzision"]


def test_exact_name_comes_first(rows):
    names, found = run(q="gamma capital")
    assert names[0] == "Gamma Capital"
    assert found.found_by[rows["Gamma Capital"]] == ["keyword", "vector"]


def test_reembeds_only_changed_text(rows):
    from app import embeddings
    from app.db import session_scope

    FAKE_EMBEDDER.calls.clear()
    assert embeddings.embed_pending() == 0
    with session_scope() as session:
        session.execute(text("UPDATE company_search SET embed_text = 'Other text' "
                             "WHERE name = 'Delta IT'"))
    assert embeddings.embed_pending() == 1
    assert FAKE_EMBEDDER.calls == [["Other text\nCountry: Austria"]]


def test_falls_back_to_keywords_when_embedding_fails(rows, monkeypatch):
    from app import embeddings, llm

    class Down:
        model = FAKE_EMBEDDER.model

        def embed(self, texts, quick=False):
            raise llm.LLMError("down", 503)

    monkeypatch.setattr(llm, "embedder", lambda: Down())
    embeddings.query_vector.cache_clear()
    names, found = run(q="gamma")
    assert found.mode == "keyword" and names == ["Gamma Capital"]


def test_query_instruction_goes_before_queries_only(rows, monkeypatch):
    """Qwen3-Embedding wants its task before a query; company texts stay as
    they are (they were embedded by the `rows` fixture without it)."""
    from types import SimpleNamespace

    from app import embeddings

    monkeypatch.setattr(embeddings, "settings", lambda: SimpleNamespace(
        embedding_query_instruction="Find companies"))
    embeddings.query_vector.cache_clear()
    FAKE_EMBEDDER.calls.clear()
    try:
        run(q="gamma")
        assert FAKE_EMBEDDER.calls == [["Instruct: Find companies\nQuery:gamma"]]
    finally:
        embeddings.query_vector.cache_clear()


def test_agent_tool_passes_filters(rows):
    import json

    from app.agent.tools import CorpusSearch, _corpus_search
    from app.db import session_scope

    args = CorpusSearch(query="medical device contract manufacturing", regions=["dach"],
                        employees_min=50, employees_max=500, revenue_min_m=50,
                        revenue_currency="CHF")
    with session_scope() as session:
        out = json.loads(_corpus_search(session, args).content)
    # Hand-made search rows have no observations, so snapshots carry ids only.
    assert [i["id"] for i in out["items"]] == [
        str(rows["Alpha Medtech"]), str(rows["Beta Präzision"])]
    assert "approximate rates" in out["revenue_note"]
    assert {i["matched"] for i in out["items"]} == {"meaning"}
    assert "isn't in our data" in out["note"]
    with pytest.raises(ValueError, match="ISO 3166"):
        CorpusSearch(query="x", countries=["Germany"])
