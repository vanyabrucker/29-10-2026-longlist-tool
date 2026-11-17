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
    CheckConstraint,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, TSVECTOR, UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


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
    source_type: Mapped[str] = mapped_column(ForeignKey("source_types.key"))
    as_of: Mapped[date | None] = mapped_column(Date)
    # Optionally also attach the rows to a longlist (existing or new).
    list_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("longlists.id"))
    new_list_name: Mapped[str | None] = mapped_column(String(255))
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
    __tablename__ = "longlists"
    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True, default=_uuid)
    name: Mapped[str] = mapped_column(String(255))
    created_version_id: Mapped[int | None] = mapped_column(ForeignKey("versions.id"))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )


class Entity(Base):
    """A company, person, role, transaction, project reference or list entry.

    Child kinds point at their parents (role → person + company, list_entry →
    list + company). Data lives in observations, not here.
    """

    __tablename__ = "entities"
    id: Mapped[uuid.UUID] = mapped_column(UUID, primary_key=True, default=_uuid)
    kind: Mapped[str] = mapped_column(String(20), index=True)
    company_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("entities.id"), index=True
    )
    person_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("entities.id"))
    list_id: Mapped[uuid.UUID | None] = mapped_column(ForeignKey("longlists.id"))
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
    hq: Mapped[str | None] = mapped_column(Text)
    description: Mapped[str | None] = mapped_column(Text)
    revenue: Mapped[float | None] = mapped_column(Float)  # latest fiscal year
    employees: Mapped[int | None] = mapped_column(BigInteger)
    document: Mapped[str] = mapped_column(TSVECTOR)


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
