"""Company embeddings for semantic search.

`company_search.embed_text` (built in SQL with the rest of the search row) is
what a company is embedded from; `company_embeddings` holds one vector per
company with the hash of the text and the model it came from.

Embedding runs **right after commit**, not inside it: it is a network call
that can be slow or fail, and an import commit, pin or revert must never wait
for it or roll back over it. `search.refresh` marks the session, and once the
transaction commits a background thread embeds every company whose text hash
or model differs from its stored vector. Startup runs the same sweep, so a
crash or provider outage only delays vectors. Until a company has one it is
still found by keywords; a changed company keeps its old vector until the new
one is in (close enough for ranking in the meantime).
"""

from __future__ import annotations

import logging
import threading
from functools import lru_cache

import pycountry
from sqlalchemy import event, text
from sqlalchemy.orm import Session

from app import llm
from app.config import settings

log = logging.getLogger("uvicorn.error")

BATCH = 64
MARK = "search_changed"

# The hash covers exactly what `embedding_input` reads.
HASH = "md5(s.embed_text || '|' || coalesce(s.country, ''))"


def embedding_input(embed_text: str, country: str | None) -> str:
    """The row's text plus the HQ country's name (the row only has its code)."""
    if country and (c := pycountry.countries.get(alpha_2=country)):
        return f"{embed_text}\nCountry: {c.name}"
    return embed_text


def to_sql(vector: list[float]) -> str:
    """pgvector's text form, bound as a parameter and cast to vector."""
    return "[" + ",".join(f"{x:.7g}" for x in vector) + "]"


def stale(session: Session, model: str, limit: int) -> list[tuple]:
    """(entity_id, embed_text, country, hash) of companies needing a vector."""
    return session.execute(text(f"""
        SELECT s.entity_id, s.embed_text, s.country, {HASH}
        FROM company_search s
        LEFT JOIN company_embeddings ce ON ce.entity_id = s.entity_id
        WHERE s.embed_text IS NOT NULL
          AND (ce.entity_id IS NULL OR ce.model <> :model OR ce.text_hash <> {HASH})
        ORDER BY s.entity_id
        LIMIT :limit"""), {"model": model, "limit": limit}).all()


def embed_pending(max_batches: int | None = None) -> int:
    """Embed every stale company, a batch per short transaction (the model
    call happens outside any transaction). Returns how many were embedded."""
    from app.db import SessionLocal

    embedder = llm.embedder()
    done = 0
    batches = 0
    while max_batches is None or batches < max_batches:
        with SessionLocal() as session:
            rows = stale(session, embedder.model, BATCH)
        if not rows:
            break
        vectors = embedder.embed([embedding_input(t, c) for _, t, c, _ in rows])
        with SessionLocal.begin() as session:
            for (entity_id, _, _, digest), vector in zip(rows, vectors, strict=True):
                session.execute(text("""
                    INSERT INTO company_embeddings (entity_id, model, text_hash,
                                                    embedding, embedded_at)
                    SELECT :id, :model, :hash, CAST(:v AS vector), now()
                    WHERE EXISTS (SELECT 1 FROM entities WHERE id = :id)
                    ON CONFLICT (entity_id) DO UPDATE SET model = excluded.model,
                      text_hash = excluded.text_hash, embedding = excluded.embedding,
                      embedded_at = excluded.embedded_at"""),
                    {"id": entity_id, "model": embedder.model, "hash": digest,
                     "v": to_sql(vector)})
        done += len(rows)
        batches += 1
    return done


@lru_cache(maxsize=512)
def query_vector(model: str, query: str) -> str | None:
    """A search query's vector (pgvector text), or None when the provider
    fails, so search falls back to keywords instead of erroring."""
    try:
        return to_sql(llm.embedder().embed([query], quick=True)[0])
    except (llm.LLMError, KeyError, IndexError, ValueError) as e:
        log.warning("Query embedding failed, searching by keywords only: %s", e)
        return None


def embed_query(query: str) -> str | None:
    vector = query_vector(llm.embedder().model, query)
    if vector is None:
        query_vector.cache_clear()  # don't remember an outage
    return vector


# ── Background sweep after commit ─────────────────────────────────────────

_lock = threading.Lock()
_running = False
_again = False


def wake() -> None:
    """Start the sweep thread, or make the running one look again."""
    global _running, _again
    if not settings().embed_in_background:
        return
    with _lock:
        if _running:
            _again = True
            return
        _running = True
    threading.Thread(target=_loop, name="embeddings", daemon=True).start()


def _loop() -> None:
    global _running, _again
    while True:
        try:
            n = embed_pending()
            if n:
                log.info("Embedded %d companies for search", n)
        except Exception:  # provider or DB outage; retried on the next wake
            log.exception("Embedding companies failed; they stay keyword-only for now")
        with _lock:
            if not _again:
                _running = False
                return
            _again = False


def mark(session: Session) -> None:
    """Called by search.refresh: embed once this transaction commits."""
    session.info[MARK] = True


@event.listens_for(Session, "after_commit")
def _after_commit(session: Session) -> None:
    if session.info.pop(MARK, False):
        wake()


@event.listens_for(Session, "after_rollback")
def _after_rollback(session: Session) -> None:
    session.info.pop(MARK, None)
