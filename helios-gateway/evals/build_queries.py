"""Writes `evals/search_queries.json`: realistic scoping searches with the
companies from the fictional corpus that should come back.

Each case has the search as someone would type it into one box (`as_text`,
what the agent sent before filters existed), the same search split into a
plain-words `query` plus structured `filters`, and the `expected` companies:
derived from the generator's ground truth (segment, country, size) rather
than from search output, so the set can't flatter either method.

    uv run python -m evals.build_queries
"""

import json
from pathlib import Path

from app.regions import APPROX_EUR_PER_UNIT, REGIONS
from evals.corpus import Company, generate

OUT = Path(__file__).with_name("search_queries.json")


def revenue_eur_m(c: Company) -> float | None:
    # As imported ("EUR 12.3m"), at the rates the revenue filter uses.
    if c.revenue is None:
        return None
    return round(c.revenue / 1e6, 1) * APPROX_EUR_PER_UNIT[c.currency]


def matches(c: Company, segments, filters: dict) -> bool:
    if c.segment not in segments:
        return False
    places = set(filters.get("countries", []))
    for r in filters.get("regions", []):
        places |= set(REGIONS[r])
    if places and c.country not in places:
        return False
    if "buyer_category" in filters and c.buyer_category != filters["buyer_category"]:
        return False
    if filters.get("investor_types") and c.investor_type not in filters["investor_types"]:
        return False
    lo, hi = filters.get("employees_min"), filters.get("employees_max")
    if (lo is not None or hi is not None) and (
            c.employees is None or (lo is not None and c.employees < lo)
            or (hi is not None and c.employees > hi)):
        return False
    lo, hi = filters.get("revenue_min_m"), filters.get("revenue_max_m")
    if lo is not None or hi is not None:
        rate = APPROX_EUR_PER_UNIT[filters.get("revenue_currency", "EUR")]
        eur = revenue_eur_m(c)
        if eur is None or (lo is not None and eur < lo * rate) or (
                hi is not None and eur > hi * rate):
            return False
    return True


# (id, as_text, query, filters, segments that are right answers)
CASES = [
    ("medtech-cdmo-de", ("medical device contract manufacturers in Germany with "
     "50-500 employees"), "medical device contract manufacturer",
     {"countries": ["DE"], "employees_min": 50, "employees_max": 500},
     {"medtech_cdmo"}),
    ("medtech-cdmo-german-query", ("Lohnfertiger für Medizintechnik in der Schweiz "
     "und Österreich"), "Lohnfertiger für Medizintechnik",
     {"countries": ["CH", "AT"]}, {"medtech_cdmo"}),
    ("medtech-cdmo-europe-paraphrase", ("outsourced manufacturing partners for "
     "medtech OEMs in Europe above EUR 20m revenue"),
     "outsourced manufacturing partner for medtech OEMs",
     {"regions": ["europe"], "revenue_min_m": 20}, {"medtech_cdmo"}),
    ("sap-dach", "SAP S/4HANA consultancies in DACH", "SAP S/4HANA consultancy",
     {"regions": ["dach"]}, {"sap_consulting"}),
    ("sap-strategic-50m", ("strategic buyers: ERP implementation partners with more "
     "than EUR 50m revenue"), "ERP implementation partner",
     {"buyer_category": "Strategic", "revenue_min_m": 50}, {"sap_consulting"}),
    ("it-services-europe", ("European IT services groups with revenue over EUR "
     "100m"), "IT services group",
     {"regions": ["europe"], "revenue_min_m": 100}, {"it_services"}),
    ("pe-dach", ("mid-market buyout funds investing in Mittelstand companies in "
     "the DACH region"), "buyout fund investing in Mittelstand companies",
     {"regions": ["dach"], "investor_types": ["PE"]}, {"pe_funds"}),
    ("family-office-ch", "Swiss family offices holding companies long term",
     "family holding with long-term majority stakes", {"countries": ["CH"]},
     {"family_offices"}),
    ("precision-dach", ("precision machining suppliers for semiconductor and "
     "aerospace in DACH"), "precision machining for semiconductor and aerospace",
     {"regions": ["dach"]}, {"precision_machining"}),
    ("engineering-de-ch", ("engineering service providers for product development "
     "in Germany or Switzerland"), "engineering services for product development",
     {"countries": ["DE", "CH"]}, {"engineering_services"}),
    ("automation-dach", ("builders of automated assembly lines and robot cells in "
     "DACH"), "automated assembly lines and robot integration",
     {"regions": ["dach"]}, {"automation"}),
    ("scm-software", "supply chain planning and warehouse software vendors",
     "supply chain planning and warehouse management software", {},
     {"supply_chain_software"}),
    ("packaging-pharma", "packaging machine makers for pharma and food",
     "packaging machines for pharma and food", {}, {"packaging_machinery"}),
    ("cyber-europe", "managed security operations centre providers in Europe",
     "managed security operations centre provider", {"regions": ["europe"]},
     {"cybersecurity"}),
    ("vc-early", "early-stage venture capital investors", ("early-stage venture "
     "capital"), {"investor_types": ["VC"]}, {"venture"}),
    ("medtech-oem-nordics", ("Nordic makers of their own medical devices for "
     "hospitals"), "manufacturer of its own medical devices sold to hospitals",
     {"regions": ["nordics"]}, {"medtech_oem"}),
]


def main() -> None:
    companies = generate()
    cases = []
    for cid, as_text, query, filters, segments in CASES:
        expected = sorted(c.name for c in companies if matches(c, segments, filters))
        assert expected, cid
        cases.append({"id": cid, "as_text": as_text, "query": query,
                      "filters": filters, "expected": expected})
    # Look-ups by name, typo and website must stay exact.
    sample = companies[123]
    typo = sample.name[:-2] + sample.name[-1]  # drop the second-to-last letter
    for cid, q in (("name", sample.name), ("name-typo", typo),
                   ("website", sample.website)):
        cases.append({"id": cid, "as_text": q, "query": q, "filters": {},
                      "expected": [sample.name]})
    OUT.write_text(json.dumps({"corpus_seed": "evals/corpus.py SEED", "cases": cases},
                              indent=2, ensure_ascii=False) + "\n")
    print(f"{len(cases)} cases → {OUT}")


if __name__ == "__main__":
    main()
