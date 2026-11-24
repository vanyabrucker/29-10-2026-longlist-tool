"""Recognise rows as companies and people already in the master database.

Companies, in order: registry / Capital IQ / Orbis ID or website domain
(certain), name without legal form plus country (likely), similar name
(suggestion only). People: email or LinkedIn URL (certain), name plus company
(likely). The dev confirms likely matches and suggestions in review.
"""

import re
import unicodedata
from dataclasses import dataclass, field

from rapidfuzz import fuzz, process
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.ingest.platforms import shared_host
from app.models import CurrentValue, Entity, Observation

LEGAL_FORMS = re.compile(
    r"\b(gmbh(\s*&\s*co\.?\s*kg)?|ag|sa|s\.a\.|ltd\.?|limited|llc|inc\.?|plc|se|"
    r"kg|kgaa|bv|b\.v\.|nv|n\.v\.|ab|as|a/s|oy|spa|s\.p\.a\.|srl|sarl|s\.a\.r\.l\.|"
    r"co\.?|corp\.?|corporation|holding|group|gruppe|unternehmensbeteiligungs"
    r"gesellschaft)\b",
    re.IGNORECASE,
)
FUZZY_MIN = 88

COMPANY_IDS = ("registry_id", "capiq_id", "orbis_id")


def norm_name(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode()
    s = LEGAL_FORMS.sub(" ", s.lower())
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def norm_id(value: str) -> str:
    return re.sub(r"[^a-z0-9]", "", str(value).lower())


@dataclass
class Match:
    level: str  # certain | likely | suggestion | none
    entity_id: str | None = None
    label: str | None = None
    reason: str = ""


@dataclass
class Index:
    """Lookup tables built from the current (winning) values."""

    ids: dict[str, str] = field(default_factory=dict)  # "capiq:iq123" → id
    domains: dict[str, str] = field(default_factory=dict)
    names: dict[str, list[tuple[str, str | None]]] = field(default_factory=dict)
    labels: dict[str, str] = field(default_factory=dict)
    emails: dict[str, str] = field(default_factory=dict)
    linkedins: dict[str, str] = field(default_factory=dict)
    # (normalised full name, company id) → person id
    person_names: dict[tuple[str, str], str] = field(default_factory=dict)
    person_labels: dict[str, str] = field(default_factory=dict)

    def match_company(self, values: dict) -> Match:
        for key in COMPANY_IDS:
            if (v := values.get(key)) and (hit := self.ids.get(f"{key}:{norm_id(v)}")):
                return Match("certain", hit, self.labels.get(hit), f"same {key}")
        if (d := values.get("website")) and (hit := self.domains.get(d)):
            return Match("certain", hit, self.labels.get(hit), "same website")
        name = values.get("name") or values.get("legal_name")
        if not name:
            return Match("none")
        key = norm_name(name)
        country = (values.get("hq") or {}).get("country")
        for entity_id, their_country in self.names.get(key, []):
            if not country or not their_country or country == their_country:
                return Match("likely", entity_id, self.labels.get(entity_id),
                             "same name" + (" and country" if country else ""))
        if self.names:
            best = process.extractOne(key, list(self.names), scorer=fuzz.token_sort_ratio)
            if best and best[1] >= FUZZY_MIN:
                entity_id = self.names[best[0]][0][0]
                return Match("suggestion", entity_id, self.labels.get(entity_id),
                             f"similar name ({round(best[1])}%)")
        return Match("none")

    def match_person(self, values: dict, company_id: str | None) -> Match:
        if (e := values.get("email")) and (hit := self.emails.get(e)):
            return Match("certain", hit, self.person_labels.get(hit), "same email")
        if (u := values.get("person_linkedin_url")) and (
            hit := self.linkedins.get(u.rstrip("/").lower())
        ):
            return Match("certain", hit, self.person_labels.get(hit), "same LinkedIn")
        full = person_name(values)
        if full and company_id and (
            hit := self.person_names.get((norm_name(full), company_id))
        ):
            return Match("likely", hit, self.person_labels.get(hit),
                         "same name at the same company")
        return Match("none")


def person_name(values: dict) -> str:
    return " ".join(
        p for p in (values.get("first_name"), values.get("last_name")) if p
    ) or values.get("full_name") or ""


def build_index(session: Session) -> Index:
    rows = session.execute(
        select(CurrentValue.entity_id, CurrentValue.field, Observation.value,
               Entity.kind, Entity.company_id)
        .join(Observation, Observation.id == CurrentValue.observation_id)
        .join(Entity, Entity.id == CurrentValue.entity_id)
        .where(Entity.kind.in_(("company", "person")))
    ).all()
    idx = Index()
    company_values: dict[str, dict] = {}
    person_values: dict[str, dict] = {}
    for entity_id, fld, value, kind, _company_id in rows:
        eid = str(entity_id)
        v = value.get("v")
        if kind == "company":
            company_values.setdefault(eid, {})[fld] = v
        elif kind == "person":
            person_values.setdefault(eid, {})[fld] = v
    for eid, vals in company_values.items():
        label = vals.get("name") or vals.get("legal_name") or eid[:8]
        idx.labels[eid] = label
        for key in COMPANY_IDS:
            if vals.get(key):
                idx.ids[f"{key}:{norm_id(vals[key])}"] = eid
        # A page on a shared platform (stored before they were refused) says
        # nothing about which company it is.
        if vals.get("website") and not shared_host(vals["website"]):
            idx.domains[vals["website"]] = eid
        country = (vals.get("hq") or {}).get("country")
        for n in (vals.get("name"), vals.get("legal_name")):
            if n:
                idx.names.setdefault(norm_name(n), []).append((eid, country))
    for eid, vals in person_values.items():
        idx.person_labels[eid] = person_name(vals) or eid[:8]
        if vals.get("email"):
            idx.emails[vals["email"]] = eid
        if vals.get("person_linkedin_url"):
            idx.linkedins[vals["person_linkedin_url"].rstrip("/").lower()] = eid
    # People ↔ companies via their roles (a role may have no values of its own).
    roles = session.execute(
        select(Entity.person_id, Entity.company_id).where(Entity.kind == "role")
    ).all()
    for person_id, company_id in roles:
        if person_id and str(person_id) in person_values:
            full = person_name(person_values[str(person_id)])
            if full:
                idx.person_names[(norm_name(full), str(company_id))] = str(
                    person_id
                )
    return idx
