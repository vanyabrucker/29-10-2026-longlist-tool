"""Database tables.

Values are never overwritten: every value is an append-only `Observation` with
its source, as-of date and the version that added it. The value shown is the
one with the best quality score (`current_values`, rebuilt after each change).
Reverting a version marks its observations retracted by a newer version.
"""

import uuid
from datetime import date, datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column
from sqlalchemy.types import UserDefinedType

from app.config import EMBEDDING_COLUMN_DIMENSIONS


class Base(DeclarativeBase):
    pass


def _uuid() -> uuid.UUID:
    return uuid.uuid4()


class SourceType(Base):
    """Where data comes from, with its confidence (0–1) for quality scores."""

    __tablename__ = "source_types"
    key: Mapped[str] = mapped_column(String(40), primary_key=True)
    label: Mapped[str] = mapped_column(String(80))
    confidence: Mapped[float] = mapped_column(Float)
    sort: Mapped[int] = mapped_column(Integer, default=0)


class Document(Base):
    """An uploaded original file, kept in object storage."""

    __tablename__ = "documents"
    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True, default=_uuid)
    filename: Mapped[str] = mapped_column(String(255))
    sha256: Mapped[str] = mapped_column(String(64), index=True)
    size: Mapped[int] = mapped_column(BigInteger)
    content_type: Mapped[str | None] = mapped_column(String(120))
    storage_key: Mapped[str] = mapped_column(String(255))
    uploaded_by: Mapped[str] = mapped_column(String(255))
    uploaded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Version(Base):
    """One entry in the global history: an import, a revert or a manual edit."""

    __tablename__ = "versions"
    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    kind: Mapped[str] = mapped_column(String(20))  # import | revert | manual | pin
    import_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID, ForeignKey("imports.id", use_alter=True)
    )
    reverts_version_id: Mapped[int | None] = mapped_column(ForeignKey("versions.id"))
    # Set on a version once it has been reverted (and cleared if re-applied).
    reverted_by_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("versions.id")
    )
    author: Mapped[str] = mapped_column(String(255))
    message: Mapped[str] = mapped_column(Text)
    counts: Mapped[dict] = mapped_column(JSONB, default=dict)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Import(Base):
    """One import run, from upload through review to commit."""

    __tablename__ = "imports"
    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True, default=_uuid)
    document_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("documents.id"))
    # uploaded → analysing → mapping_review → building_report → report_review
    # → committing → committed; or failed / cancelled. Reverts live on Version.
    status: Mapped[str] = mapped_column(String(30), default="uploaded")
    step: Mapped[str | None] = mapped_column(String(200))
    progress: Mapped[float] = mapped_column(Float, default=0)
    eta_seconds: Mapped[int | None] = mapped_column(Integer)
    step_started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error: Mapped[str | None] = mapped_column(Text)
    warnings: Mapped[list] = mapped_column(JSONB, default=list)
    # Unset until the reviewer says where the data is from (never set for a
    # verified Helios export); the report can't be built without it.
    source_type: Mapped[str | None] = mapped_column(ForeignKey("source_types.key"))
    # With source "other": the name the uploader gave it ("Broker list"), a note
    # that is never shown as the source; and who claimed the source (both
    # copied onto every observation it writes).
    source_note: Mapped[str | None] = mapped_column(String(120))
    source_by: Mapped[str | None] = mapped_column(String(255))
    as_of: Mapped[date | None] = mapped_column(Date)
    # Optionally also attach the rows to a longlist (existing or new).
    list_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("longlists.id"))
    new_list_name: Mapped[str | None] = mapped_column(String(255))
    # corpus (dev-only: observations as one global version) or list (anyone:
    # one list version through apply_changes).
    target: Mapped[str] = mapped_column(String(10), default="corpus")
    # The verified Helios export the file came from (its signed `_helios` mark).
    export_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("list_exports.id"))
    # The chat the file was dropped into, if any.
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("sessions.id", ondelete="SET NULL"))
    # The list version a list import committed as.
    list_version: Mapped[int | None] = mapped_column(Integer)
    catalogue_version: Mapped[str] = mapped_column(String(40))
    # Detected tables, each with its range, header and column mapping.
    tables: Mapped[list] = mapped_column(JSONB, default=list)
    feedback: Mapped[list] = mapped_column(JSONB, default=list)
    report: Mapped[dict | None] = mapped_column(JSONB)
    # Per-row match decisions made in review: {"t0:r12": "new" | "skip" | id}
    decisions: Mapped[dict] = mapped_column(JSONB, default=dict)
    version_id: Mapped[int | None] = mapped_column(ForeignKey("versions.id"))
    created_by: Mapped[str] = mapped_column(String(255))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now(), onupdate=func.now()
    )


class RawRow(Base):
    """A data row exactly as parsed, so a later re-mapping needs no re-upload."""

    __tablename__ = "raw_rows"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    import_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("imports.id", ondelete="CASCADE"), index=True
    )
    table_index: Mapped[int] = mapped_column(Integer)
    sheet: Mapped[str] = mapped_column(String(255))
    row_number: Mapped[int] = mapped_column(Integer)  # 1-based, as in Excel
    cells: Mapped[list] = mapped_column(JSONB)  # values in column order


class Longlist(Base):
    """A buyer longlist. Its history is its own numbered versions
    (`list_versions`), separate from the corpus's global versions."""

    __tablename__ = "longlists"
    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255))
    # The company being sold ("Consilio"); free text.
    target: Mapped[str | None] = mapped_column(String(255))
    kind: Mapped[str | None] = mapped_column(String(20))  # financial | strategic
    owner: Mapped[str] = mapped_column(String(255))  # email
    head_version: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("kind IN ('financial', 'strategic')", name="ck_longlists_kind"),
    )


class ListVersion(Base):
    """One change to a list (`app.longlists.apply_changes`): numbered per list."""

    __tablename__ = "list_versions"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    list_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("longlists.id"))
    number: Mapped[int] = mapped_column(Integer)
    author: Mapped[str] = mapped_column(String(255))  # email, or "agent"
    message: Mapped[str] = mapped_column(Text)
    # The global corpus version at that moment: an older list version reads
    # corpus values as they were then.
    corpus_version: Mapped[int] = mapped_column(Integer)
    # The version this one restored, if it is a restore.
    reverts: Mapped[int | None] = mapped_column(Integer)
    import_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("imports.id"))
    # Cells, rows and columns changed.
    changes: Mapped[int] = mapped_column(Integer, default=0)
    # Corpus facts edited from this list: [{entry_id, field, old, new}]. They
    # live in the corpus (a manual observation, prioritized), not in states.
    corpus_edits: Mapped[list] = mapped_column(JSONB, default=list)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("list_id", "number", name="uq_list_versions_number"),
    )


class ListExport(Base):
    """One .xlsx export of a list. The workbook carries this id, signed, so a
    file coming back can be diffed against exactly what was written."""

    __tablename__ = "list_exports"
    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True, default=_uuid)
    list_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("longlists.id"), index=True)
    list_version: Mapped[int] = mapped_column(Integer)
    corpus_version: Mapped[int] = mapped_column(Integer)
    exported_by: Mapped[str] = mapped_column(String(255))
    columns: Mapped[list] = mapped_column(JSONB, default=list)  # [{key, label, type}]
    rows: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ListExportCell(Base):
    """A cell as an export wrote it (the Excel value, not the normalised one)."""

    __tablename__ = "list_export_cells"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    export_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("list_exports.id", ondelete="CASCADE"), index=True)
    entry_id: Mapped[uuid.UUID] = mapped_column(UUID)
    company_id: Mapped[uuid.UUID | None] = mapped_column(UUID)
    key: Mapped[str] = mapped_column(String(80))
    value: Mapped[object | None] = mapped_column(JSONB)

    __table_args__ = (
        Index("ix_list_export_cells_company_key", "company_id", "key"),
        Index("ix_list_export_cells_entry_key", "entry_id", "key"),
    )


class ListEntry(Base):
    """A row of a list: a corpus company, or (company_id null) a row whose
    company isn't in the corpus yet; its data then lives in its states."""

    __tablename__ = "list_entries"
    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True, default=_uuid)
    list_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("longlists.id"), index=True)
    company_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("entities.id"))
    created_version: Mapped[int] = mapped_column(Integer)


class ListColumn(Base):
    """A list's column as of a range of list versions: [valid_from, valid_to).
    A change closes the current row and inserts a new one; removing a column
    closes it without a successor."""

    __tablename__ = "list_columns"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    list_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("longlists.id"))
    key: Mapped[str] = mapped_column(String(80))
    label: Mapped[str] = mapped_column(String(120))
    type: Mapped[str] = mapped_column(String(20))
    position: Mapped[int] = mapped_column(Integer)
    # corpus:<data point> (the corpus's shown value, live), list (relevance
    # score / explanation) or custom (list-only, never in the catalogue).
    source: Mapped[str] = mapped_column(String(80))
    valid_from: Mapped[int] = mapped_column(Integer)
    valid_to: Mapped[int | None] = mapped_column(Integer)

    __table_args__ = (Index("ix_list_columns_list_valid_to", "list_id", "valid_to"),)


class ListEntryState(Base):
    """A full snapshot of an entry's list data for [valid_from, valid_to).
    Unchanged entries aren't copied into new versions."""

    __tablename__ = "list_entry_states"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    entry_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("list_entries.id"), index=True)
    list_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("longlists.id"))
    valid_from: Mapped[int] = mapped_column(Integer)
    valid_to: Mapped[int | None] = mapped_column(Integer)
    relevance_score: Mapped[float | None] = mapped_column(Float)
    removed: Mapped[bool] = mapped_column(Boolean, default=False)
    # Relevance explanation, custom column values, and the corpus columns'
    # values of an entry that has no corpus company.
    data: Mapped[dict] = mapped_column(JSONB, default=dict)
    # Where each list-only value came from: {key: {type web|agent|manual, by,
    # at, url?, title?}}. Scored like corpus values; not part of the diff.
    provenance: Mapped[dict] = mapped_column(JSONB, default=dict)

    __table_args__ = (Index("ix_list_entry_states_list_valid_to", "list_id", "valid_to"),)


class Entity(Base):
    """A company, person, role, transaction or project reference.

    Child kinds point at their parents (role → person + company). Data lives
    in observations, not here. List entries live in `list_entries`.
    """

    __tablename__ = "entities"
    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True, default=_uuid)
    kind: Mapped[str] = mapped_column(String(20), index=True)
    company_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("entities.id"), index=True
    )
    person_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("entities.id"))
    created_version_id: Mapped[int] = mapped_column(ForeignKey("versions.id"))


class Observation(Base):
    __tablename__ = "observations"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    entity_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("entities.id"))
    field: Mapped[str] = mapped_column(String(60))
    # Fiscal year for periodic data points (revenue 2024 vs 2023); else null.
    period: Mapped[int | None] = mapped_column(Integer)
    value: Mapped[dict] = mapped_column(JSONB)  # normalised, see normalize.py
    raw: Mapped[str | None] = mapped_column(Text)  # as written in the source
    source_type: Mapped[str] = mapped_column(ForeignKey("source_types.key"))
    document_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("documents.id"))
    # For source "other": the name the uploader gave it (a note, not shown
    # as the source), and who said the data came from there.
    source_note: Mapped[str | None] = mapped_column(String(120))
    source_by: Mapped[str | None] = mapped_column(String(255))
    sheet: Mapped[str | None] = mapped_column(String(255))
    row: Mapped[int | None] = mapped_column(Integer)
    col: Mapped[str | None] = mapped_column(String(10))  # Excel letter, e.g. "C"
    as_of: Mapped[date | None] = mapped_column(Date)
    version_id: Mapped[int] = mapped_column(ForeignKey("versions.id"), index=True)
    retracted_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("versions.id"), index=True
    )

    __table_args__ = (Index("ix_observations_entity_field", "entity_id", "field"),)


class CurrentValue(Base):
    """The winning observation per entity, field and period."""

    __tablename__ = "current_values"
    entity_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("entities.id"), primary_key=True
    )
    field: Mapped[str] = mapped_column(String(60), primary_key=True)
    # 0 for non-periodic data points (part of the key, so not nullable).
    period: Mapped[int] = mapped_column(Integer, primary_key=True)
    observation_id: Mapped[int] = mapped_column(ForeignKey("observations.id"))
    score: Mapped[float] = mapped_column(Float)
    # How many live observations compete for this value.
    sources: Mapped[int] = mapped_column(Integer)
    # Set when a person prioritized this observation over the score.
    pin_id: Mapped[int | None] = mapped_column(ForeignKey("value_pins.id"))


class ValuePin(Base):
    """A person prioritizing one observation for a data point, over the
    quality score. Append-only events: the newest live event per entity,
    field and period decides; an event without an observation removes the
    priority. Each event is its own version, so reverting it undoes it."""

    __tablename__ = "value_pins"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    entity_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("entities.id"))
    field: Mapped[str] = mapped_column(String(60))
    period: Mapped[int] = mapped_column(Integer)  # 0 for non-periodic points
    observation_id: Mapped[int | None] = mapped_column(ForeignKey("observations.id"))
    pinned_by: Mapped[str] = mapped_column(String(255))  # email
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    version_id: Mapped[int] = mapped_column(ForeignKey("versions.id"), index=True)
    retracted_version_id: Mapped[int | None] = mapped_column(
        ForeignKey("versions.id"), index=True
    )

    __table_args__ = (Index("ix_value_pins_entity_field", "entity_id", "field", "period"),)


class CompanySearch(Base):
    """One row per company with its shown values, for search, sorting and
    paging in SQL. Rebuilt with current_values, in the same transaction."""

    __tablename__ = "company_search"
    entity_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("entities.id"), primary_key=True
    )
    name: Mapped[str | None] = mapped_column(Text)
    website: Mapped[str | None] = mapped_column(Text)
    sector: Mapped[str | None] = mapped_column(Text)
    sub_sector: Mapped[str | None] = mapped_column(Text)
    hq: Mapped[str | None] = mapped_column(Text)
    country: Mapped[str | None] = mapped_column(String(2), index=True)  # HQ, ISO
    description: Mapped[str | None] = mapped_column(Text)
    revenue: Mapped[float | None] = mapped_column(Float)  # latest fiscal year
    revenue_currency: Mapped[str | None] = mapped_column(String(3))
    # The employee range's bounds; either may be open.
    employees_low: Mapped[int | None] = mapped_column(BigInteger)
    employees_high: Mapped[int | None] = mapped_column(BigInteger)
    buyer_category: Mapped[str | None] = mapped_column(Text)
    investor_type: Mapped[str | None] = mapped_column(Text)
    # What the company is embedded from (app/embeddings.py).
    embed_text: Mapped[str | None] = mapped_column(Text)
    document: Mapped[str] = mapped_column(TSVECTOR)


class Vector(UserDefinedType):
    """pgvector's column type; values travel in its text form ('[1,2,3]')."""

    cache_ok = True

    def __init__(self, dimensions: int):
        self.dimensions = dimensions

    def get_col_spec(self, **_kw) -> str:
        return f"vector({self.dimensions})"


class CompanyEmbedding(Base):
    """One vector per company for semantic search, with the hash of the text
    and the model it came from; redone after commit when either changes.
    Read and written in SQL (app/embeddings.py, app/search.py)."""

    __tablename__ = "company_embeddings"
    entity_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("entities.id", ondelete="CASCADE"), primary_key=True)
    model: Mapped[str] = mapped_column(String(120))
    text_hash: Mapped[str] = mapped_column(String(32))
    embedding: Mapped[str] = mapped_column(Vector(EMBEDDING_COLUMN_DIMENSIONS))
    embedded_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())


# ── Users ──────────────────────────────────────────────────────────────────


class User(Base):
    """A person who can sign in. Passwords are stored as scrypt hashes."""

    __tablename__ = "users"
    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True, default=_uuid)
    email: Mapped[str] = mapped_column(String(255), unique=True)  # lower case
    name: Mapped[str] = mapped_column(String(120))
    password_hash: Mapped[str] = mapped_column(String(255))
    # member < admin < dev: each role holds the rights of the ones before it.
    # Devs also use the import area (/admin in the frontend).
    role: Mapped[str] = mapped_column(String(20), default="member")
    language: Mapped[str] = mapped_column(String(5), default="en")  # en | de
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    last_login_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    __table_args__ = (
        CheckConstraint("role IN ('member', 'admin', 'dev')", name="ck_users_role"),
    )

    @property
    def is_admin(self) -> bool:
        return self.role in ("admin", "dev")

    @property
    def is_dev(self) -> bool:
        return self.role == "dev"


class AuthSession(Base):
    """A signed-in browser. Only the token's SHA-256 is stored."""

    __tablename__ = "auth_sessions"
    token_hash: Mapped[str] = mapped_column(String(64), primary_key=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))


# ── Agent chats ────────────────────────────────────────────────────────────


class AgentConfig(Base):
    """A versioned agent setup. A chat keeps the version it started with."""

    __tablename__ = "agent_configs"
    version: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(80), default="helios")
    model: Mapped[str] = mapped_column(String(120))
    system_prompt: Mapped[str] = mapped_column(Text)
    # Tool names enabled for this version (web_research may still be gated per session).
    tools: Mapped[list] = mapped_column(JSONB, default=list)
    # [{name, text}] copied from app/agent/skills (versions 1–3 hold names only).
    skills: Mapped[list] = mapped_column(JSONB, default=list)
    # sha256 of the content; app.agent.config finds or creates versions by it.
    content_hash: Mapped[str | None] = mapped_column(String(64), index=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class ChatSession(Base):
    """A private chat (= Recents). Owner-only; lists it works on stay shared."""

    __tablename__ = "sessions"
    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True, default=_uuid)
    owner: Mapped[str] = mapped_column(String(255), index=True)  # email
    title: Mapped[str] = mapped_column(String(255), default="")
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    status: Mapped[str] = mapped_column(String(20), default="idle")  # running | idle
    stop_reason: Mapped[str | None] = mapped_column(String(40))
    # end_turn | requires_action | interrupted | error | None while first run pending
    agent_config_version: Mapped[int] = mapped_column(ForeignKey("agent_configs.version"))
    # Longlists this chat created or is editing (UUIDs as strings).
    list_ids: Mapped[list] = mapped_column(JSONB, default=list)
    # Web research (Exa): off until approved for the whole chat, for this run
    # (`web_research_once`), or for one exact query (`web_research_allowed_query`).
    # Once/query allowances clear when the run goes idle (not on requires_action).
    web_research_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    web_research_once: Mapped[bool] = mapped_column(Boolean, default=False)
    web_research_allowed_query: Mapped[str | None] = mapped_column(Text)
    web_searches_used: Mapped[int] = mapped_column(Integer, default=0)
    # Pending ask_user tool call id while status is requires_action / idle waiting.
    pending_tool_call_id: Mapped[str | None] = mapped_column(String(80))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        CheckConstraint("status IN ('running', 'idle')", name="ck_sessions_status"),
        CheckConstraint(
            "stop_reason IS NULL OR stop_reason IN "
            "('end_turn', 'requires_action', 'interrupted', 'error')",
            name="ck_sessions_stop_reason",
        ),
    )


class SessionFeedback(Base):
    """How a chat went, from its owner (Bad / Fine / Good, an optional
    comment), asked once a list exists. One row per chat: a dismissed ask is
    a row without a rating, so the chat doesn't ask again. Devs work through
    the rated ones in the eval dashboard (status, note). The chat's title
    and agent setup are copied in, so the row survives the chat's deletion."""

    __tablename__ = "session_feedback"
    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True, default=_uuid)
    session_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("sessions.id", ondelete="SET NULL"), unique=True)
    owner: Mapped[str] = mapped_column(String(255), index=True)  # email
    session_title: Mapped[str] = mapped_column(String(255), default="")
    agent_config_version: Mapped[int | None] = mapped_column(Integer)
    rating: Mapped[str | None] = mapped_column(String(10))  # bad | fine | good | None
    comment: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(20), default="todo")
    note: Mapped[str | None] = mapped_column(Text)  # the dev's analysis
    analyzed_by: Mapped[str | None] = mapped_column(String(255))
    # The eval dataset sample made from this chat, once a dev added it.
    dataset_sample: Mapped[str | None] = mapped_column(String(80))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now())

    __table_args__ = (
        CheckConstraint("rating IS NULL OR rating IN ('bad', 'fine', 'good')",
                        name="ck_session_feedback_rating"),
        CheckConstraint("status IN ('todo', 'in_progress', 'done')",
                        name="ck_session_feedback_status"),
    )


class SessionEvent(Base):
    """Append-only typed log for one chat. The UI only displays this log."""

    __tablename__ = "session_events"
    id: Mapped[int] = mapped_column(BigInteger, primary_key=True)
    session_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("sessions.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    type: Mapped[str] = mapped_column(String(40))
    payload: Mapped[dict] = mapped_column(JSONB, default=dict)
    # When the agent loop finished handling a queued user event (None = pending).
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )

    __table_args__ = (
        UniqueConstraint("session_id", "seq", name="uq_session_events_seq"),
        Index("ix_session_events_session_seq", "session_id", "seq"),
    )
