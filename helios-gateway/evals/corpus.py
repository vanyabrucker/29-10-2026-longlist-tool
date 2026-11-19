"""A fictional company corpus for search development and evaluation.

About 370 made-up companies in segments that matter for buyer-universe
scoping (SAP consultancies, IT service groups, medtech contract
manufacturers, precision engineering, investors, …) plus look-alike segments
that share words but not meaning (plastics moulding vs medical moulding,
hospital software vs medical devices). Descriptions vary their wording and
about a quarter of DACH companies describe themselves in German, so keyword
search misses paraphrases that semantic search should catch. Revenue is in
each company's home currency; some revenue and headcount figures are missing.

Deterministic (fixed seed): the evaluation set names companies from it, so
changing the generator means regenerating `search_queries.json`. Every name
and domain is invented (`.example` style domains on real TLDs are avoided by
a `-demo` suffix).
"""

from __future__ import annotations

import random
from dataclasses import dataclass, field

SEED = 20261119

CURRENCY = {"DE": "EUR", "AT": "EUR", "NL": "EUR", "FR": "EUR", "IT": "EUR",
            "ES": "EUR", "BE": "EUR", "FI": "EUR", "CH": "CHF", "SE": "SEK",
            "DK": "DKK", "NO": "NOK", "GB": "GBP", "PL": "PLN", "CZ": "CZK",
            "US": "USD"}
# Rough units of home currency per EUR, so sizes stay plausible per country.
PER_EUR = {"EUR": 1, "CHF": 0.94, "SEK": 11.5, "DKK": 7.46, "NOK": 11.8,
           "GBP": 0.85, "PLN": 4.3, "CZK": 25, "USD": 1.09}
CITIES = {
    "DE": ["Munich", "Stuttgart", "Hamburg", "Berlin", "Frankfurt", "Cologne",
           "Nuremberg", "Freiburg", "Tuttlingen", "Jena", "Dresden", "Karlsruhe"],
    "AT": ["Vienna", "Graz", "Linz", "Innsbruck"],
    "CH": ["Zurich", "Basel", "Bern", "Lucerne", "St. Gallen", "Neuchâtel"],
    "NL": ["Amsterdam", "Eindhoven", "Rotterdam", "Utrecht"],
    "FR": ["Lyon", "Paris", "Besançon", "Toulouse"],
    "IT": ["Milan", "Bologna", "Turin"],
    "ES": ["Barcelona", "Madrid"],
    "BE": ["Antwerp", "Ghent"],
    "FI": ["Helsinki", "Oulu"],
    "SE": ["Stockholm", "Gothenburg", "Malmö"],
    "DK": ["Copenhagen", "Aarhus"],
    "NO": ["Oslo", "Bergen"],
    "GB": ["London", "Manchester", "Cambridge"],
    "PL": ["Warsaw", "Wrocław", "Kraków"],
    "CZ": ["Prague", "Brno"],
    "US": ["Boston", "Minneapolis", "Chicago", "Austin"],
}
TLD = {"DE": "de", "AT": "at", "CH": "ch", "NL": "nl", "FR": "fr", "IT": "it",
       "ES": "es", "BE": "be", "FI": "fi", "SE": "se", "DK": "dk", "NO": "no",
       "GB": "co.uk", "PL": "pl", "CZ": "cz", "US": "com"}
LEGAL = {"DE": "GmbH", "AT": "GmbH", "CH": "AG", "NL": "B.V.", "FR": "SAS",
         "IT": "S.r.l.", "ES": "S.L.", "BE": "NV", "FI": "Oy", "SE": "AB",
         "DK": "A/S", "NO": "AS", "GB": "Ltd", "PL": "Sp. z o.o.", "CZ": "s.r.o.",
         "US": "Inc."}
GERMAN = {"DE", "AT", "CH"}

STEMS = ["Isar", "Rhein", "Alpen", "Nord", "Boden", "Taunus", "Elbe", "Main",
         "Neckar", "Weser", "Donau", "Saale", "Jura", "Linden", "Falken", "Adler",
         "Brenner", "Eiger", "Kessel", "Mosel", "Lahn", "Ems", "Spree", "Harz",
         "Aster", "Corvi", "Veluwe", "Fjord", "Silva", "Arden", "Tauri", "Lumen",
         "Orbis", "Caldera", "Meridian", "Helio", "Polar", "Vireo", "Quarz",
         "Sorin", "Kestrel", "Aurel", "Vanta", "Tessin", "Ligur", "Nexo", "Pentra",
         "Solva", "Trion", "Velo"]


@dataclass(frozen=True)
class Segment:
    key: str
    count: int
    sector: str
    sub_sectors: tuple[str, ...]
    suffixes: tuple[str, ...]
    countries: tuple[str, ...]
    # Employees range; revenue per employee in EUR thousand (range).
    employees: tuple[int, int]
    rev_per_head: tuple[int, int]
    what: tuple[str, ...]  # English: "a contract manufacturer of …"
    details: tuple[str, ...]
    was: tuple[str, ...] = ()  # German: "ein Lohnfertiger für …"
    details_de: tuple[str, ...] = ()
    products: tuple[str, ...] = ()
    services: tuple[str, ...] = ()
    keywords: tuple[str, ...] = ()
    buyer: str = "Strategic"
    investor_type: str | None = "Strategic Investor"
    owner_types: tuple[str, ...] = ("Founder/family", "PE-backed",
                                    "Corporate subsidiary")
    value_chain: str | None = None


SEGMENTS: list[Segment] = [
    Segment(
        "sap_consulting", 30, "IT Services", ("SAP consulting", "ERP consulting"),
        ("Consulting", "Solutions", "Advisory", "Digital"),
        ("DE", "DE", "DE", "CH", "AT", "NL", "PL", "DK"), (40, 900), (110, 170),
        ("an SAP consultancy", "an SAP partner", "an ERP implementation partner",
         "a consulting firm for SAP S/4HANA projects"),
        ("It migrates mid-sized manufacturers from ECC to S/4HANA",
         "It implements SAP finance, controlling and supply chain modules",
         ("Its consultants run SAP rollouts and application management for "
         "industrial clients"), "It specialises in SAP EWM warehouse projects"),
        ("ein SAP-Beratungshaus", "ein SAP-Partner für den Mittelstand"),
        ("Es begleitet Industrieunternehmen bei der Umstellung auf S/4HANA",
         "Schwerpunkte sind SAP FI/CO, MM und Produktionsplanung"),
        services=("S/4HANA migration", "SAP application management",
                  "SAP EWM", "SAP FI/CO"),
        keywords=("SAP", "S/4HANA", "ERP"), value_chain="Service Provider"),
    Segment(
        "it_services", 30, "IT Services", ("IT services", "Managed services",
                                           "Digital transformation"),
        ("IT Group", "Technologies", "Systems", "Digital Services"),
        ("DE", "NL", "FR", "GB", "SE", "PL", "CH", "US"), (300, 6000), (90, 160),
        ("an IT services group", "a managed services provider",
         "a digital transformation consultancy", "an IT outsourcing company"),
        (("It runs data centres, cloud migrations and service desks for "
         "enterprises"), "It grows by acquiring regional IT consultancies",
         "Its practices cover cloud, data, ERP and cybersecurity",
         "It provides nearshore software development and IT operations"),
        ("ein IT-Dienstleister", "ein Systemhaus"),
        ("Es betreibt Rechenzentren und betreut Cloud-Migrationen",
         "Das Unternehmen wächst durch Zukäufe regionaler IT-Berater"),
        services=("cloud migration", "managed services", "service desk",
                  "application development"),
        keywords=("cloud", "outsourcing", "IT consulting"),
        value_chain="Service Provider"),
    Segment(
        "supply_chain_software", 20, "Software", ("Supply chain software",
                                                  "ERP & supply chain software"),
        ("Software", "Logistics Software", "Planning", "Analytics"),
        ("DE", "NL", "SE", "FI", "GB", "US", "CH"), (30, 600), (120, 220),
        ("a supply chain planning software vendor",
         "a developer of warehouse management software",
         "a SaaS company for demand forecasting and inventory optimisation"),
        ("Its software plans production and inventory for manufacturers",
         "Customers use it to forecast demand and replenish stock",
         "It integrates with SAP and Microsoft Dynamics"),
        ("ein Softwarehaus für Supply-Chain-Planung",),
        ("Die Software plant Bestände und Produktion für Hersteller",),
        products=("demand planning", "warehouse management system",
                  "inventory optimisation"),
        keywords=("supply chain", "SaaS", "planning"), value_chain="Manufacturer"),
    Segment(
        "medtech_cdmo", 26, "Healthcare", ("Medical devices", "Medical technology",
                                           "Contract manufacturing"),
        ("Medical", "MedTech", "Precision Medical", "Medical Manufacturing"),
        ("DE", "DE", "DE", "CH", "CH", "AT", "NL", "FR", "PL",
         "CZ", "US", "IT"), (40, 1200), (90, 180),
        ("a contract manufacturer of medical devices",
         "a CDMO for orthopaedic implants and surgical instruments",
         "an EMS provider for medical electronics",
         "a development and manufacturing partner for medtech OEMs",
         "a supplier of cleanroom-moulded components for diagnostics"),
        ("It machines titanium implants and builds instruments to ISO 13485",
         "OEMs outsource design transfer, assembly and sterile packaging to it",
         "It produces catheters and single-use devices under contract",
         "It assembles electronics for patient monitors and infusion pumps",
         ("It injection-moulds components in ISO class 7 cleanrooms for "
         "diagnostics companies")),
        ("ein Lohnfertiger für Medizintechnik",
         "ein Auftragsfertiger für Medizinprodukte",
         "ein Entwicklungs- und Fertigungspartner für Medizintechnik-Hersteller"),
        (("Das Unternehmen fertigt Implantate und chirurgische Instrumente nach "
         "ISO 13485"), ("Es übernimmt Montage, Reinraumverpackung und Sterilisation "
         "für OEMs"), "Gefertigt werden Katheter und Einwegprodukte im Auftrag"),
        services=("contract manufacturing", "design transfer", "cleanroom assembly",
                  "sterile packaging"),
        keywords=("ISO 13485", "medical devices", "CDMO", "cleanroom"),
        value_chain="Manufacturer"),
    Segment(
        "medtech_oem", 20, "Healthcare", ("Medical devices", "Diagnostics",
                                          "Surgical equipment"),
        ("Medical", "Surgical", "Diagnostics", "Health Technologies"),
        ("DE", "CH", "DK", "SE", "NL", "US", "FR"), (60, 3000), (150, 280),
        ("a maker of surgical instruments", "a developer of diagnostic analysers",
         "a manufacturer of patient monitoring devices",
         "a producer of endoscopy systems"),
        ("It sells its own branded products to hospitals in 40 countries",
         "Its devices are CE-marked and FDA-cleared",
         "It develops and markets its own product range"),
        ("ein Hersteller chirurgischer Instrumente", "ein Medizingerätehersteller"),
        ("Das Unternehmen vertreibt eigene Produkte an Kliniken weltweit",),
        products=("surgical instruments", "diagnostic analysers", "endoscopes",
                  "patient monitors"),
        keywords=("medical devices", "hospitals", "CE mark"),
        value_chain="Manufacturer"),
    Segment(
        "plastics_moulding", 16, "Industrials", ("Plastics", "Injection moulding"),
        ("Kunststofftechnik", "Plastics", "Moulding", "Polymer"),
        ("DE", "AT", "CZ", "PL", "IT"), (50, 800), (100, 170),
        ("an injection moulder for automotive parts",
         "a plastics processor for packaging and household goods",
         "a toolmaker and injection moulder for consumer products"),
        ("It moulds interior trim and housings for car makers",
         "It produces caps, closures and containers in high volumes",
         "Tools are built in-house"),
        ("ein Kunststoffspritzgießer für die Automobilindustrie",),
        ("Gefertigt werden Innenraumteile und Gehäuse für Fahrzeughersteller",),
        services=("injection moulding", "toolmaking"),
        keywords=("plastics", "automotive", "injection moulding"),
        value_chain="Manufacturer"),
    Segment(
        "health_it", 12, "Software", ("Healthcare IT", "Hospital software"),
        ("Health Software", "Clinical Systems", "eHealth"),
        ("DE", "CH", "AT", "NL", "DK", "FI"), (40, 700), (110, 190),
        ("a hospital information system vendor",
         "a developer of software for clinics and care homes"),
        ("Its software manages patient records, billing and scheduling",
         "It sells electronic health record systems to hospitals"),
        ("ein Anbieter von Krankenhaussoftware",),
        ("Die Software verwaltet Patientenakten und Abrechnung",),
        products=("hospital information system", "electronic health record"),
        keywords=("healthcare", "software", "hospitals"),
        value_chain="Manufacturer"),
    Segment(
        "precision_machining", 24, "Industrials", ("Precision engineering",
                                                   "Machining"),
        ("Präzisionstechnik", "Precision", "Feinmechanik", "Components"),
        ("DE", "DE", "CH", "AT", "CZ", "IT", "SE"), (30, 700), (90, 160),
        ("a precision machining company", "a supplier of turned and milled parts",
         "a maker of high-precision mechanical components"),
        (("It machines parts for aerospace, semiconductor and machine-building "
         "customers"), "It runs 5-axis CNC milling and Swiss-type turning",
         "Customers include optics and semiconductor equipment makers"),
        ("ein Präzisionsteilefertiger", "ein Zulieferer für Dreh- und Frästeile"),
        ("Das Unternehmen fertigt Präzisionsteile für Luftfahrt und Halbleiter",),
        services=("CNC machining", "turning", "milling"),
        keywords=("precision", "CNC", "aerospace"), value_chain="Manufacturer"),
    Segment(
        "engineering_services", 24, "Engineering", ("Engineering services",
                                                    "Product development"),
        ("Engineering", "Technik", "Development", "Ingenieure"),
        ("DE", "CH", "AT", "FR", "GB", "SE", "NL"), (50, 2500), (80, 140),
        ("an engineering services firm", "a product development consultancy",
         "an engineering consultancy for mechanical and electronics design"),
        ("Its engineers design products for medtech and industrial clients",
         "It offers mechanical, electronics and software development on contract",
         "It supports automotive and rail clients with simulation and testing"),
        ("ein Ingenieurdienstleister", "ein Entwicklungsdienstleister"),
        (("Ingenieure entwickeln Produkte für Kunden aus Industrie und "
         "Medizintechnik"),),
        services=("product development", "simulation", "testing", "embedded software"),
        keywords=("engineering", "R&D", "product development"),
        value_chain="Engineering"),
    Segment(
        "automation", 20, "Industrials", ("Industrial automation", "Robotics"),
        ("Automation", "Robotics", "Automatisierung", "Systems"),
        ("DE", "CH", "AT", "IT", "DK", "SE", "US"), (40, 1500), (120, 200),
        ("a builder of automated assembly lines", "a robotics integrator",
         "a maker of special-purpose machines"),
        (("It designs and builds custom automation for automotive and medtech "
         "plants"), "It integrates industrial robots and vision systems",
         "Its machines assemble and test components at high speed"),
        ("ein Sondermaschinenbauer", "ein Automatisierungsspezialist"),
        (("Das Unternehmen baut Montageanlagen für Automobil- und "
         "Medizintechnikkunden"),),
        products=("assembly lines", "special-purpose machines"),
        keywords=("automation", "robotics", "machine building"),
        value_chain="Manufacturer"),
    Segment(
        "packaging_machinery", 16, "Industrials", ("Packaging machinery",),
        ("Packaging", "Verpackungstechnik", "Pack Systems"),
        ("DE", "IT", "CH", "NL"), (60, 1500), (130, 210),
        ("a maker of packaging machines", "a supplier of filling and capping lines"),
        ("Its machines fill, seal and label food and pharma products",
         "It builds blister and cartoning lines"),
        ("ein Verpackungsmaschinenhersteller",),
        ("Die Maschinen füllen und verschließen Lebensmittel und Pharmaprodukte",),
        products=("filling machines", "cartoning lines", "blister machines"),
        keywords=("packaging", "food", "pharma"), value_chain="Manufacturer"),
    Segment(
        "cybersecurity", 15, "IT Services", ("Cybersecurity",),
        ("Security", "Cyber", "Defence"), ("DE", "CH", "NL", "GB", "FI", "PL"),
        (20, 600), (110, 200),
        ("a cybersecurity services firm", "a managed detection and response provider",
         "a penetration testing company"),
        ("It runs a 24/7 security operations centre",
         "It tests networks and applications for banks and industry"),
        ("ein IT-Sicherheitsdienstleister",),
        ("Das Unternehmen betreibt ein Security Operations Center",),
        services=("penetration testing", "SOC", "incident response"),
        keywords=("cybersecurity", "SOC", "security"),
        value_chain="Service Provider"),
    Segment(
        "logistics", 14, "Transport & Logistics", ("Contract logistics",
                                                   "Freight forwarding"),
        ("Logistics", "Logistik", "Freight", "Spedition"),
        ("DE", "NL", "BE", "PL", "CZ", "AT"), (100, 4000), (60, 120),
        ("a contract logistics provider", "a freight forwarder"),
        ("It runs warehouses and road freight for retailers",
         "It specialises in temperature-controlled pharma logistics"),
        ("ein Logistikdienstleister", "eine Spedition"),
        ("Das Unternehmen betreibt Lager und Transporte für den Handel",),
        services=("warehousing", "road freight", "pharma logistics"),
        keywords=("logistics", "warehousing"), value_chain="Service Provider"),
    Segment(
        "dental", 10, "Healthcare", ("Dental products", "Dental laboratories"),
        ("Dental", "Dentaltechnik"), ("DE", "CH", "AT", "IT"), (20, 500), (90, 170),
        ("a dental laboratory group", "a maker of dental implants and prosthetics"),
        ("It mills crowns and bridges for dentists",
         "It produces dental implants and abutments"),
        ("ein Dentallabor-Verbund",),
        ("Gefertigt werden Kronen, Brücken und Implantate",),
        products=("crowns", "dental implants"), keywords=("dental",),
        value_chain="Manufacturer"),
    Segment(
        "pe_funds", 30, "Financial Services", ("Private equity", "Buyout"),
        ("Capital", "Capital Partners", "Equity Partners", "Beteiligungen"),
        ("DE", "DE", "CH", "AT", "NL", "GB", "SE", "FR", "US"), (8, 60), (0, 0),
        ("a mid-market private equity firm", "a buyout investor",
         "a private equity investor in family-owned companies"),
        (("It acquires majority stakes in Mittelstand companies with EUR 10–100m "
         "revenue"), ("Focus sectors are industrial technology, healthcare and "
         "business services"), "It backs buy-and-build platforms in IT services",
         "It invests in succession situations in the DACH region"),
        ("eine Beteiligungsgesellschaft", "ein Private-Equity-Investor"),
        ("Sie erwirbt Mehrheitsbeteiligungen an mittelständischen Unternehmen",
         "Schwerpunkte sind Industrietechnik, Gesundheit und Dienstleistungen"),
        keywords=("private equity", "buyout", "Mittelstand"),
        buyer="Financial", investor_type="PE",
        owner_types=("Other",)),
    Segment(
        "growth_equity", 10, "Financial Services", ("Growth equity",),
        ("Growth Partners", "Growth Capital"), ("DE", "CH", "GB", "NL", "SE"),
        (5, 40), (0, 0),
        ("a growth equity investor", "a minority growth investor"),
        (("It takes minority stakes in profitable software and tech-enabled "
         "services companies"), "It funds expansion of founder-led companies"),
        ("ein Wachstumsinvestor",),
        ("Er beteiligt sich minderheitlich an profitablen Softwarefirmen",),
        keywords=("growth equity", "minority"), buyer="Financial",
        investor_type="PE", owner_types=("Other",)),
    Segment(
        "venture", 14, "Financial Services", ("Venture capital",),
        ("Ventures", "VC", "Venture Partners"), ("DE", "CH", "GB", "FI", "SE", "US"),
        (4, 30), (0, 0),
        ("a venture capital fund", "an early-stage investor"),
        ("It backs seed to Series B startups in deep tech and digital health",
         "It invests in early-stage B2B software"),
        ("ein Risikokapitalgeber",),
        ("Er finanziert Start-ups von Seed bis Series B",),
        keywords=("venture capital", "startups"), buyer="Financial",
        investor_type="VC", owner_types=("Other",)),
    Segment(
        "family_offices", 14, "Financial Services", ("Family office",),
        ("Holding", "Family Office", "Familienholding"), ("DE", "CH", "AT", "NL"),
        (3, 25), (0, 0),
        ("a single family office", "an industrial family holding"),
        ("It invests the family's wealth in long-term majority holdings",
         "It buys and holds industrial companies without an exit horizon"),
        ("eine Familienholding", "ein Family Office"),
        ("Sie hält langfristig Mehrheitsbeteiligungen an Industrieunternehmen",),
        keywords=("family office", "long-term"), buyer="Financial",
        investor_type="Family Office", owner_types=("Founder/family",)),
    Segment(
        "energy_services", 14, "Energy", ("Renewable energy services",
                                          "Solar installation"),
        ("Energy", "Solar", "Energietechnik"), ("DE", "NL", "DK", "ES", "AT"),
        (30, 900), (90, 180),
        ("a solar installer", "a wind turbine service company"),
        ("It installs rooftop solar and battery storage for businesses",
         "It maintains onshore wind farms"),
        ("ein Solarinstallateur",),
        ("Das Unternehmen installiert Photovoltaik und Speicher für Gewerbe",),
        services=("solar installation", "wind service"),
        keywords=("renewables", "solar", "wind"), value_chain="Service Provider"),
    Segment(
        "food_ingredients", 12, "Food & Beverage", ("Food ingredients",),
        ("Foods", "Ingredients", "Lebensmittel"), ("DE", "NL", "DK", "FR", "IT"),
        (50, 2000), (150, 300),
        ("a food ingredients producer", "a maker of flavours and baking mixes"),
        ("It supplies bakeries and food makers with mixes and flavours",
         "It produces plant-based proteins"),
        ("ein Hersteller von Lebensmittelzutaten",),
        ("Das Unternehmen beliefert Bäckereien mit Backmischungen",),
        products=("baking mixes", "flavours", "plant proteins"),
        keywords=("food", "ingredients"), value_chain="Manufacturer"),
]


@dataclass
class Company:
    name: str
    legal_name: str
    website: str
    segment: str
    sector: str
    sub_sector: str
    country: str
    city: str
    description: str
    founded: int
    buyer_category: str
    investor_type: str | None
    owner_type: str
    revenue: float | None  # home currency, latest year
    currency: str
    employees: int | None
    aum: float | None
    products: list[str] = field(default_factory=list)
    services: list[str] = field(default_factory=list)
    keywords: list[str] = field(default_factory=list)
    value_chain: str | None = None
    german: bool = False

    @property
    def revenue_eur_m(self) -> float | None:
        if self.revenue is None:
            return None
        return self.revenue / PER_EUR[self.currency] / 1e6


def generate() -> list[Company]:
    rng = random.Random(SEED)
    used: set[str] = set()
    out: list[Company] = []
    for seg in SEGMENTS:
        for _ in range(seg.count):
            country = rng.choice(seg.countries)
            city = rng.choice(CITIES[country])
            while True:
                stem = rng.choice(STEMS)
                suffix = rng.choice(seg.suffixes)
                name = f"{stem} {suffix}"
                if name not in used:
                    used.add(name)
                    break
            slug = name.lower().replace(" ", "-").replace("ä", "ae").replace(
                "ö", "oe").replace("ü", "ue")
            german = country in GERMAN and bool(seg.was) and rng.random() < 0.3
            if german:
                what, detail = rng.choice(seg.was), rng.choice(seg.details_de)
                description = f"{name} ist {what} mit Sitz in {city}. {detail}."
            else:
                what = rng.choice(seg.what)
                details = rng.sample(seg.details, k=min(2, len(seg.details)))
                description = f"{name} is {what} based in {city}. " + ". ".join(
                    details) + "."
            currency = CURRENCY[country]
            lo, hi = seg.employees
            employees = round(rng.lognormvariate(0, 0.9) * (lo * hi) ** 0.5)
            employees = max(lo, min(hi, employees))
            revenue = aum = None
            if seg.buyer == "Financial":
                aum = round(rng.uniform(0.2, 6) * 1e9 * PER_EUR[currency], -6)
                emp: int | None = employees if rng.random() < 0.5 else None
            else:
                per_head = rng.uniform(*seg.rev_per_head) * 1000
                revenue = round(employees * per_head * PER_EUR[currency], -5)
                if rng.random() < 0.22:
                    revenue = None
                emp = employees if rng.random() < 0.88 else None
            out.append(Company(
                name=name, legal_name=f"{name} {LEGAL[country]}",
                website=f"{slug}-demo.{TLD[country]}", segment=seg.key,
                sector=seg.sector, sub_sector=rng.choice(seg.sub_sectors),
                country=country, city=city, description=description,
                founded=rng.randint(1950, 2018), buyer_category=seg.buyer,
                investor_type=seg.investor_type,
                owner_type=rng.choice(seg.owner_types), revenue=revenue,
                currency=currency, employees=emp, aum=aum,
                products=rng.sample(seg.products, k=min(2, len(seg.products))),
                services=rng.sample(seg.services, k=min(2, len(seg.services))),
                keywords=list(seg.keywords), value_chain=seg.value_chain,
                german=german))
    return out


HEADERS = ["Company name", "Legal name", "Website", "Description", "Sector",
           "Sub-sector", "Headquarters", "Founded", "Buyer category",
           "Investor type", "Owner type", "Revenue 2025", "Employees", "AUM",
           "Products", "Services", "Industry keywords", "Value chain position"]


def _money(amount: float | None, currency: str) -> str | None:
    return None if amount is None else f"{currency} {amount / 1e6:.1f}m"


def rows(companies: list[Company]) -> list[list]:
    return [[c.name, c.legal_name, c.website, c.description, c.sector, c.sub_sector,
             f"{c.city}, {c.country}", c.founded, c.buyer_category, c.investor_type,
             c.owner_type, _money(c.revenue, c.currency), c.employees,
             _money(c.aum, c.currency), "; ".join(c.products) or None,
             "; ".join(c.services) or None, "; ".join(c.keywords) or None,
             c.value_chain] for c in companies]


def workbook() -> bytes:
    import io

    from openpyxl import Workbook

    wb = Workbook()
    ws = wb.active
    ws.title = "Companies"
    ws.append(HEADERS)
    for r in rows(generate()):
        ws.append(r)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()
