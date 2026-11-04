"""The data-point catalogue: the fixed master data model.

Every value in the master database is one of these data points. The LLM maps
spreadsheet columns against the descriptions, synonyms and examples here, so
they're written for that reader. Changes are rare; bump CATALOGUE_VERSION when
they happen (each import records the version it was mapped against).
"""

from dataclasses import dataclass
from typing import Literal

CATALOGUE_VERSION = "2026-11-04.1"

# What a row's values describe. Companies, people and roles are matched across
# imports; the others are child records of a company (or of a list).
Entity = Literal[
    "company", "person", "role", "transaction", "project_ref", "list_entry"
]

DataType = Literal[
    "text",
    "long_text",
    "int",
    "decimal",
    "money",  # amount + ISO currency (+ fiscal year for periodic points)
    "percent",  # 0–100
    "date",
    "year",
    "bool",
    "enum",
    "url",
    "domain",
    "email",
    "phone",
    "country",  # ISO 3166-1 alpha-2
    "location",  # {city, region, country}
]


@dataclass(frozen=True)
class DataPoint:
    key: str
    entity: Entity
    label: str
    type: DataType
    description: str
    # Several values at once (a list), e.g. markets or products.
    many: bool = False
    options: tuple[str, ...] = ()
    synonyms: tuple[str, ...] = ()
    examples: tuple[str, ...] = ()
    # Days until freshness halves; None means it doesn't go stale.
    half_life_days: int | None = 365
    # Only meaningful for some buyers, e.g. "financial" or "investor_type=VC".
    applies_to: str | None = None
    # Values are per fiscal year (financial metrics).
    periodic: bool = False
    # Used to recognise the same record across files.
    identity: bool = False


Y = 365

INVESTOR_TYPES = (
    "VC",
    "CVC",
    "PE",
    "Family Office",
    "HNWI",
    "Angel Investor",
    "Strategic Investor",
)

_POINTS: list[DataPoint] = [
    # ── Company: identity ───────────────────────────────────────────────
    DataPoint(
        "name", "company", "Company name", "text",
        "The name the company is usually known by, without legal form if it is "
        "commonly dropped. Required for every company row.",
        synonyms=("company", "buyer", "buyer name", "firm", "investor", "target",
                  "Unternehmen", "Firma", "Name"),
        examples=("BWK", "Isarblick Capital Partners"),
        half_life_days=3 * Y, identity=True,
    ),
    DataPoint(
        "legal_name", "company", "Legal name", "text",
        "Full registered name including the legal form (GmbH, AG, Ltd, SA...).",
        synonyms=("registered name", "Firmenname", "legal entity"),
        examples=("BWK GmbH Unternehmensbeteiligungsgesellschaft",),
        half_life_days=3 * Y, identity=True,
    ),
    DataPoint(
        "website", "company", "Website", "domain",
        "Main web domain of the company, without protocol or path. The strongest "
        "match key after registry and database IDs.",
        synonyms=("url", "web", "homepage", "domain", "Webseite"),
        examples=("bwk.de", "helbling.ch"),
        half_life_days=int(1.5 * Y), identity=True,
    ),
    DataPoint(
        "registry_id", "company", "Registry ID", "text",
        "Commercial-register or company identification number, e.g. Swiss UID or "
        "German Handelsregister number.",
        synonyms=("UID", "HRB", "company number", "Handelsregisternummer"),
        examples=("CHE-123.456.789", "HRB 12345"),
        half_life_days=None, identity=True,
    ),
    DataPoint(
        "capiq_id", "company", "Capital IQ ID", "text",
        "S&P Capital IQ company identifier.",
        synonyms=("CIQ ID", "S&P ID", "Company ID (CIQ)"),
        examples=("IQ1234567",), half_life_days=None, identity=True,
    ),
    DataPoint(
        "orbis_id", "company", "Orbis ID", "text",
        "Bureau van Dijk Orbis identifier (BvD ID).",
        synonyms=("BvD ID", "BvD ID number"),
        examples=("DE7330123456",), half_life_days=None, identity=True,
    ),
    DataPoint(
        "linkedin_url", "company", "LinkedIn page", "url",
        "Company page on LinkedIn.",
        synonyms=("linkedin", "company linkedin"),
        examples=("https://www.linkedin.com/company/bwk",),
        half_life_days=2 * Y, identity=True,
    ),
    DataPoint(
        "description", "company", "Description", "long_text",
        "Short description of what the company does.",
        synonyms=("business description", "profile", "about", "Beschreibung"),
        half_life_days=Y,
    ),
    DataPoint(
        "founded", "company", "Founded", "year",
        "Year the company was founded.",
        synonyms=("year founded", "founding year", "Gründungsjahr", "est."),
        examples=("1990",), half_life_days=None,
    ),
    # ── Company: classification ─────────────────────────────────────────
    DataPoint(
        "buyer_category", "company", "Buyer category", "enum",
        "Whether the company buys as a strategic (an operating company) or as a "
        "financial investor. Defaults from investor type: 'Strategic Investor' "
        "means Strategic, every other investor type means Financial.",
        options=("Strategic", "Financial"),
        synonyms=("buyer type", "category", "strategic/financial"),
        half_life_days=2 * Y,
    ),
    DataPoint(
        "investor_type", "company", "Investor type", "enum",
        "Kind of investor. PE includes buyout and growth equity funds; CVC is a "
        "corporate venture arm; HNWI is a wealthy private individual investing "
        "directly; Strategic Investor is an operating company.",
        options=INVESTOR_TYPES,
        synonyms=("buyer types", "investor category", "type", "Investorentyp"),
        examples=("PE", "Family Office", "Strategic Investor"),
        half_life_days=2 * Y,
    ),
    DataPoint(
        "vc_role", "company", "VC role", "enum",
        "How a venture investor usually participates in rounds.",
        options=("Lead investor", "Co-investor", "Lead & co-investor"),
        synonyms=("lead or co", "investor role"),
        half_life_days=Y, applies_to="investor_type=VC",
    ),
    # ── Company: industry ───────────────────────────────────────────────
    DataPoint(
        "sector", "company", "Sector", "text",
        "Top-level industry sector (until a fixed sector list is agreed this is "
        "free text, e.g. 'Technology', 'Industrials', 'Business Services').",
        synonyms=("industry", "Branche", "sector"),
        examples=("Technology", "Industrials"), half_life_days=3 * Y,
    ),
    DataPoint(
        "sub_sector", "company", "Sub-sector", "text",
        "Second-level industry within the sector.",
        synonyms=("sub-industry", "segment", "Teilbranche"),
        examples=("SAP consulting", "ERP & supply chain software"),
        half_life_days=3 * Y,
    ),
    DataPoint(
        "industry_keywords", "company", "Industry keywords", "text",
        "Free tags describing the business.",
        many=True,
        synonyms=("keywords", "tags", "focus areas"),
        examples=("S/4HANA", "supply chain", "production planning"),
        half_life_days=Y,
    ),
    DataPoint(
        "value_chain_position", "company", "Value chain position", "enum",
        "Where the company sits in its value chain.",
        many=True,
        options=("Manufacturer", "Distributor", "Engineering", "Service Provider"),
        synonyms=("value chain", "business model"),
        half_life_days=2 * Y,
    ),
    DataPoint(
        "end_market", "company", "End market", "enum",
        "Whether it sells to businesses, consumers or both.",
        many=True, options=("B2B", "B2C"),
        synonyms=("customers", "B2B/B2C"), half_life_days=2 * Y,
    ),
    # ── Company: financials (per fiscal year) ───────────────────────────
    DataPoint(
        "revenue", "company", "Revenue", "money",
        "Annual revenue (turnover / sales) for a fiscal year.",
        synonyms=("sales", "turnover", "Umsatz", "net sales"),
        examples=("€250M", "CHF 1.2B"), periodic=True, half_life_days=Y,
    ),
    DataPoint(
        "ebitda", "company", "EBITDA", "money",
        "Annual EBITDA for a fiscal year.", synonyms=("EBITDA",),
        periodic=True, half_life_days=Y,
    ),
    DataPoint(
        "ebit", "company", "EBIT", "money",
        "Annual EBIT (operating profit) for a fiscal year.",
        synonyms=("operating profit", "EBIT"), periodic=True, half_life_days=Y,
    ),
    DataPoint(
        "aum", "company", "AUM", "money",
        "Assets under management of a financial investor.",
        synonyms=("assets under management", "fund size", "AUM / Revenue"),
        examples=("€2.1B",), half_life_days=200, applies_to="financial",
    ),
    DataPoint(
        "ticket_size_min", "company", "Ticket size (min)", "money",
        "Smallest typical equity ticket of a financial investor.",
        synonyms=("min ticket", "minimum investment", "equity ticket from"),
        half_life_days=Y, applies_to="financial",
    ),
    DataPoint(
        "ticket_size_max", "company", "Ticket size (max)", "money",
        "Largest typical equity ticket of a financial investor.",
        synonyms=("max ticket", "maximum investment", "equity ticket to"),
        half_life_days=Y, applies_to="financial",
    ),
    # ── Company: organisation ───────────────────────────────────────────
    DataPoint(
        "employee_count", "company", "Employees", "int",
        "Number of employees (headcount or FTE).",
        synonyms=("employees", "headcount", "FTE", "staff", "Mitarbeitende"),
        examples=("200",), half_life_days=Y,
    ),
    DataPoint(
        "owner_type", "company", "Owner type", "enum",
        "Who owns the company.",
        options=("Founder/family", "PE-backed", "VC-backed", "Listed",
                 "Corporate subsidiary", "Foundation", "State", "Cooperative",
                 "Other"),
        synonyms=("ownership", "owner", "Eigentümer"), half_life_days=2 * Y,
    ),
    DataPoint(
        "ownership_structure", "company", "Ownership structure", "long_text",
        "Free description of the shareholders.",
        synonyms=("shareholders", "cap table", "Aktionariat"),
        examples=("70% founder, 30% management",), half_life_days=2 * Y,
    ),
    DataPoint(
        "hq", "company", "Headquarters", "location",
        "City and country of the head office.",
        synonyms=("HQ", "headquarters", "location", "city", "Sitz"),
        examples=("Stuttgart, DE", "Zurich, Switzerland"), half_life_days=2 * Y,
    ),
    DataPoint(
        "markets", "company", "Markets", "country",
        "Countries the company sells into.",
        many=True, synonyms=("geographies", "regions", "countries", "Märkte"),
        half_life_days=2 * Y,
    ),
    DataPoint(
        "production_sites", "company", "Production sites", "location",
        "Production or main operating sites.",
        many=True, synonyms=("plants", "sites", "factories", "Standorte"),
        half_life_days=2 * Y,
    ),
    DataPoint(
        "business_units", "company", "Business units", "text",
        "Divisions of the company.", many=True,
        synonyms=("divisions", "segments", "Geschäftsbereiche"),
        half_life_days=2 * Y,
    ),
    # ── Company: offerings ──────────────────────────────────────────────
    DataPoint(
        "products", "company", "Products", "text", "Product lines.", many=True,
        synonyms=("product portfolio", "Produkte"), half_life_days=2 * Y,
    ),
    DataPoint(
        "services", "company", "Services", "text", "Service lines.", many=True,
        synonyms=("service portfolio", "Dienstleistungen"), half_life_days=2 * Y,
    ),
    # ── Company: deal interest ──────────────────────────────────────────
    DataPoint(
        "acquisition_interest", "company", "Acquisition interest", "bool",
        "Whether the company has signalled interest in acquisitions. Empty means "
        "unknown, not no.",
        synonyms=("M&A interest", "interested", "acquisitive"),
        half_life_days=180,
    ),
    DataPoint(
        "investment_focus", "company", "Investment focus", "long_text",
        "Stated investment scope of a financial investor.",
        synonyms=("investment strategy", "focus", "mandate"),
        half_life_days=Y, applies_to="financial",
    ),
    # ── Person ──────────────────────────────────────────────────────────
    DataPoint(
        "first_name", "person", "First name", "text", "Given name.",
        synonyms=("first name", "Vorname", "given name"), half_life_days=5 * Y,
        identity=True,
    ),
    DataPoint(
        "last_name", "person", "Last name", "text", "Family name.",
        synonyms=("last name", "surname", "Nachname"), half_life_days=5 * Y,
        identity=True,
    ),
    DataPoint(
        "full_name", "person", "Full name", "text",
        "Full name in one column; split into first and last name on import.",
        synonyms=("name", "contact", "contact person", "Kontaktperson"),
        half_life_days=5 * Y, identity=True,
    ),
    DataPoint(
        "email", "person", "Email", "email", "Work email address. Main match key.",
        synonyms=("e-mail", "mail", "E-Mail"), half_life_days=2 * Y,
        identity=True,
    ),
    DataPoint(
        "phone", "person", "Phone", "phone", "Phone number.",
        synonyms=("tel", "telephone", "mobile", "Telefon"), half_life_days=2 * Y,
    ),
    DataPoint(
        "person_linkedin_url", "person", "LinkedIn profile", "url",
        "Personal LinkedIn profile URL. Second match key.",
        synonyms=("linkedin", "linkedin profile"), half_life_days=2 * Y,
        identity=True,
    ),
    DataPoint(
        "person_location", "person", "Location", "location",
        "Where the person is based.", synonyms=("based in", "city"),
        half_life_days=2 * Y,
    ),
    DataPoint(
        "languages", "person", "Languages", "enum", "Languages spoken.",
        many=True, options=("DE", "EN", "FR", "IT", "ES", "Other"),
        synonyms=("language", "Sprachen"), half_life_days=5 * Y,
    ),
    DataPoint(
        "last_contacted", "person", "Last contacted", "date",
        "When Helbling last contacted the person.",
        synonyms=("last contact", "letzter Kontakt"), half_life_days=180,
    ),
    # ── Role (person at company) ────────────────────────────────────────
    DataPoint(
        "function", "role", "Function", "enum",
        "The person's function at the company.",
        options=("CEO", "CFO", "Head of Strategy", "M&A", "Other"),
        synonyms=("role", "position", "Funktion"), half_life_days=Y,
    ),
    DataPoint(
        "title", "role", "Title", "text", "Exact job title.",
        synonyms=("job title", "position", "Titel"),
        examples=("Head of Corporate Development",), half_life_days=Y,
    ),
    DataPoint(
        "department", "role", "Department", "text", "Department.",
        synonyms=("Abteilung", "team"), half_life_days=Y,
    ),
    DataPoint(
        "start_date", "role", "Start date", "date", "When the role started.",
        synonyms=("since", "from"), half_life_days=None,
    ),
    DataPoint(
        "end_date", "role", "End date", "date",
        "When the role ended; empty means current.", synonyms=("until", "to"),
        half_life_days=None,
    ),
    DataPoint(
        "is_primary_contact", "role", "Primary contact", "bool",
        "Helbling's main contact at the company.",
        synonyms=("primary", "main contact", "Hauptkontakt"), half_life_days=180,
    ),
    # ── Transaction (child of a company) ────────────────────────────────
    DataPoint(
        "deal_date", "transaction", "Deal date", "date",
        "Announcement or closing date of a deal.",
        synonyms=("transaction date", "closing date", "announced"),
        half_life_days=None,
    ),
    DataPoint(
        "counterparty", "transaction", "Counterparty", "text",
        "The target or investee of the deal.",
        synonyms=("target", "investee", "acquired company"), half_life_days=None,
    ),
    DataPoint(
        "company_role", "transaction", "Role in deal", "enum",
        "The company's role in the deal.",
        options=("Acquirer", "Investor", "Seller", "Target"),
        half_life_days=None,
    ),
    DataPoint(
        "deal_type", "transaction", "Deal type", "enum", "Kind of transaction.",
        options=("Majority", "Minority", "Add-on", "Merger", "Carve-out", "Other"),
        synonyms=("transaction type",), half_life_days=None,
    ),
    DataPoint(
        "deal_value", "transaction", "Deal value", "money",
        "Disclosed transaction value.", synonyms=("transaction value", "EV"),
        half_life_days=None,
    ),
    DataPoint(
        "deal_notes", "transaction", "Deal notes", "text", "Notes on the deal.",
        half_life_days=None,
    ),
    # ── Project reference (child of a company) ──────────────────────────
    DataPoint(
        "project", "project_ref", "Project", "text",
        "Helbling project code or name the company appeared in.",
        synonyms=("project", "mandate", "Projekt"), half_life_days=None,
    ),
    DataPoint(
        "project_stage", "project_ref", "Project stage", "enum",
        "How far the company got in that project.",
        options=("Longlisted", "Shortlisted", "Contacted", "NDA", "Offer",
                 "Closed", "Dropped"),
        synonyms=("status", "stage"), half_life_days=None,
    ),
    DataPoint(
        "project_comments", "project_ref", "Project comments", "long_text",
        "Comments from that project.", synonyms=("comments", "notes", "remarks"),
        half_life_days=None,
    ),
    # ── List entry (per longlist, not a company fact) ───────────────────
    DataPoint(
        "relevance_score", "list_entry", "Relevance score", "percent",
        "How well the buyer fits this mandate, 0–100.",
        synonyms=("fit", "fit score", "score", "relevance", "Relevanz"),
        examples=("94", "94%"), half_life_days=None,
    ),
    DataPoint(
        "relevance_explanation", "list_entry", "Relevance explanation",
        "long_text",
        "Why the buyer fits (or doesn't fit) this mandate.",
        synonyms=("rationale", "inclusion rationale", "reasoning", "Begründung"),
        half_life_days=None,
    ),
]

CATALOGUE: dict[str, DataPoint] = {p.key: p for p in _POINTS}
assert len(CATALOGUE) == len(_POINTS), "duplicate data point keys"

# Shown in the app but derived from other data, so never mapped from a file.
COMPUTED = {
    "last_updated": "Newest observation on the company",
    "company_last_contacted": "Newest last_contacted among its people",
    "deal_count": "Number of its transactions",
    "last_deal_date": "Newest transaction date",
    "consolidated_project_knowledge": "LLM summary of its project references",
}


def as_prompt() -> str:
    """The catalogue as compact text for the LLM."""
    lines = []
    for p in _POINTS:
        bits = [f"{p.key} [{p.entity}, {p.type}{', list' if p.many else ''}]"]
        bits.append(p.description)
        if p.options:
            bits.append("options: " + " | ".join(p.options))
        if p.synonyms:
            bits.append("synonyms: " + ", ".join(p.synonyms))
        if p.periodic:
            bits.append("per fiscal year")
        lines.append(" — ".join(bits))
    return "\n".join(lines)


def to_json() -> dict:
    return {
        "version": CATALOGUE_VERSION,
        "points": [
            {
                "key": p.key,
                "entity": p.entity,
                "label": p.label,
                "type": p.type,
                "many": p.many,
                "options": list(p.options),
                "description": p.description,
                "applies_to": p.applies_to,
                "periodic": p.periodic,
            }
            for p in _POINTS
        ],
    }
