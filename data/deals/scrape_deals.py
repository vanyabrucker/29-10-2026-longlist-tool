"""Scrape completed M&A deals from advisors' public deal pages.

The deals are ground truth for evaluating Helios: given a mandate for the
target, does the agent find the buyer that actually bought it?

Sources (one function each, run with ``--source``):

- ``oaklins``: Oaklins Switzerland's deal pages (www.oaklins.com/ch), listed
  in its sitemap. The parties are only shown as a logo image, so buyer and
  target come from the page title ("X has been acquired by Y").
- ``helbling``: Helbling's reference projects and news (helbling.ch, German
  pages), kept when the page's service is "Mergers & Acquisitions". Some are
  anonymised ("Verkauf eines Schweizer Engineering-Unternehmens").

Buyer and target are read from the title with a few fixed patterns; a title
that matches none is kept with ``status = needs_review``. ``overrides.csv``
(url, target, buyer, seller, deal_type, note) corrects or fills rows by hand
and wins over the patterns.

Pages are cached in ``.cache/`` (git-ignored) so reruns don't hit the sites;
uncached pages are fetched one per second. Only the standard library is used.

Writes ``deals.jsonl`` (everything, including the page text) and
``deals.csv`` (one row per deal, UTF-8 with BOM for Excel).

    python3 data/deals/scrape_deals.py            # all sources
    python3 data/deals/scrape_deals.py --source oaklins
    python3 -m doctest data/deals/scrape_deals.py
"""

from __future__ import annotations

import argparse
import csv
import hashlib
import html
import json
import re
import sys
import time
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
OVERRIDES = HERE / "overrides.csv"
USER_AGENT = "Mozilla/5.0 (compatible; helios-deals-research/0.1)"
DELAY_S = 1.0

_last_fetch = 0.0


def fetch(url: str) -> str:
    """The page at ``url``, from the cache when it was fetched before."""
    global _last_fetch
    CACHE.mkdir(exist_ok=True)
    path = CACHE / (hashlib.sha1(url.encode()).hexdigest() + ".html")
    if path.exists():
        return path.read_text(encoding="utf-8")
    wait = DELAY_S - (time.monotonic() - _last_fetch)
    if wait > 0:
        time.sleep(wait)
    req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
    with urllib.request.urlopen(req, timeout=30) as resp:
        text = resp.read().decode("utf-8", errors="replace")
    _last_fetch = time.monotonic()
    path.write_text(text, encoding="utf-8")
    return text


def sitemap_urls(url: str) -> list[str]:
    return [html.unescape(u) for u in re.findall(r"<loc>([^<]+)</loc>", fetch(url))]


def text_lines(page: str) -> list[str]:
    """The page's visible text, one stripped non-empty line per element.

    >>> text_lines("<p>A&amp;B</p><script>x</script><div> C <b>D</b></div>")
    ['A&B', 'C', 'D']
    """
    body = re.sub(r"(?is)<(script|style|svg|noscript)\b.*?</\1>", "", page)
    body = re.sub(r"<[^>]+>", "\n", body)
    body = html.unescape(body).replace("\xa0", " ")
    return [re.sub(r"\s+", " ", ln).strip() for ln in body.splitlines() if ln.strip()]


def meta(page: str, prop: str) -> str:
    m = re.search(rf'<meta[^>]+(?:property|name)="{re.escape(prop)}"[^>]+content="([^"]*)"', page)
    return html.unescape(m.group(1)).strip() if m else ""


def after(lines: list[str], label: str) -> str:
    """The line right after the first line equal to ``label``."""
    try:
        return lines[lines.index(label) + 1]
    except (ValueError, IndexError):
        return ""


@dataclass
class Deal:
    source: str
    url: str
    title: str
    target: str = ""
    buyer: str = ""
    seller: str = ""
    deal_type: str = ""  # acquisition | merger | investment | sale
    status: str = ""  # parsed | override | needs_review | anonymous | not_a_deal
    target_kind: str = ""  # company | carve_out | unnamed
    buyer_kind: str = ""  # company | unnamed
    usable: bool = False  # a named company bought by a named buyer
    date: str = ""  # as the page gives it, e.g. "October 2025"
    industry: str = ""
    service: str = ""
    advisor_role: str = ""
    description: str = ""
    note: str = ""
    text: list[str] = field(default_factory=list, repr=False)


# --- Title patterns -------------------------------------------------------

_ART = r"(?:(?:die|der|den|das|des|the)\s+)?"
_STAKE = (r"(?:(?:an?|the|its)\s+)?(?:remaining\s+)?(?:\d+\s?%\s+)?"
          r"(?:(?:majority|minority|controlling|significant|strategic)\s+)?(?:stake|interest|shareholding)\s+in\s+"
          r"|100\s?%\s+of\s+")
_ACQUIRED = r"(?:acquired|aquired|bought|purchased|taken over)"
_SOLD = r"(?:has (?:successfully )?sold|sells|have sold)"
_FROM = r"(?: from (?P<seller>.+))?"

# (regex, deal_type); named groups target / buyer / seller. Order matters.
PATTERNS: list[tuple[re.Pattern[str], str]] = [
    (re.compile(p, re.I), t)
    for p, t in [
        # English (Oaklins)
        (rf"^(?P<target>.+?) {_SOLD} an? (?:\w+ )?(?:stake|shareholding) to (?P<buyer>.+)$", "investment"),
        (rf"^(?P<seller>.+?) {_SOLD} (?:its\s+)?(?:{_STAKE})?(?P<target>.+?) to (?P<buyer>.+)$", "sale"),
        (rf"^(?P<target>.+?) (?:and subsidiaries )?(?:has|have) been {_ACQUIRED} by (?P<buyer>.+)$", "acquisition"),
        (rf"^(?P<target>.+?) has been sold to (?P<buyer>.+)$", "acquisition"),
        (rf"^(?P<buyer>.+?) has {_ACQUIRED} (?:{_STAKE})?(?P<target>.+?){_FROM}$", "acquisition"),
        (rf"^(?P<buyer>.+?) acquires (?:{_STAKE})?(?P<target>.+?){_FROM}$", "acquisition"),
        (r"^(?P<target>.+?) has (?:received|secured) (?:an?\s+)?(?:\w+\s+)?investment from (?P<buyer>.+)$", "investment"),
        (rf"^(?P<buyer>.+?) has (?:invested|made an investment) in (?P<target>.+)$", "investment"),
        (r"^(?P<buyer>.+?) to invest in (?P<target>.+)$", "investment"),
        (r"^(?P<target>.+?) has (?:merged|combined) with (?P<buyer>.+)$", "merger"),
        (r"^(?P<target>.+?) has joined (?P<buyer>.+)$", "acquisition"),
        # A purchase price allocation names a completed acquisition.
        (r"^(?P<buyer>.+?) has (?:had a PPA conducted for|prepared a PPA following) (?:the|its) acquisition of (?P<target>.+)$", "acquisition"),
        # German (Helbling)
        (rf"^Erfolgreiche[rs]? (?:Übernahme|Akquisition|Kauf) (?:von |des |der |eines |einer )?(?P<target>.+?) durch {_ART}(?P<buyer>.+)$", "acquisition"),
        (rf"^(?:.*?)Übernahme von (?P<target>.+?) durch {_ART}(?P<buyer>.+)$", "acquisition"),
        (rf"^(?:Erfolgreiche )?Akquisition (?:des |der |von )(?P<target>.+?) für {_ART}(?P<buyer>.+)$", "acquisition"),
        (rf"^(?:Erfolgreiche[rs]? )?(?:Begleitung des )?Verkaufs? (?:der |des |von )(?P<target>.+?) an {_ART}(?P<buyer>.+)$", "acquisition"),
        (rf"^(?:Erfolgreiche )?Begleitung {_ART}(?P<buyer>.+?) bei der Akquisition (?:der |des |von )(?P<target>.+)$", "acquisition"),
        (rf"^Erfolgreicher Anteilserwerb {_ART}(?P<buyer>.+?) an {_ART}(?P<target>.+)$", "investment"),
        (rf"^(?P<buyer>.+?) übernimmt (?:gemeinsam mit .+? )?{_ART}(?P<target>.+)$", "acquisition"),
    ]
]

_ANONYMOUS = re.compile(
    r"\b(?:eine[sr]?|an?|einem)\s+(?:\w+[- ])*(?:Unternehmen|company|Gruppe|group|Familienunternehmen)s?\b"
    r"|^(?:Cross-Border-Transaktion|Unternehmensverkauf|Strategische Beteiligung|Sicherstellung|Transaktion im Bereich)",
    re.I,
)


def clean_name(name: str) -> str:
    """Trim descriptors and punctuation around a party name.

    >>> clean_name("an investment company advised by ADMETOS GmbH.")
    'an investment company advised by ADMETOS GmbH'
    >>> clean_name("  „Rickert GmbH“ ")
    'Rickert GmbH'
    """
    name = re.sub(r"\s+", " ", name.strip().strip("„“\"'").rstrip(",;:").strip())
    # A final full stop ends a sentence, except in abbreviations like S.p.A.
    if name.endswith(".") and name.split(" ")[-1].count(".") < 2:
        name = name[:-1].rstrip()
    return name


def parse_title(title: str) -> dict[str, str] | None:
    """Buyer, target (and seller) from a deal title, or None.

    >>> parse_title("Extramet has been acquired by ADMETOS")["buyer"]
    'ADMETOS'
    >>> d = parse_title("Lindenhof group has sold its stake in LabPoint to Affidea Switzerland")
    >>> d["seller"], d["target"], d["buyer"], d["deal_type"]
    ('Lindenhof group', 'LabPoint', 'Affidea Switzerland', 'sale')
    >>> d = parse_title("Erfolgreiche Übernahme von GOREX durch CWS Cleanrooms")
    >>> d["target"], d["buyer"]
    ('GOREX', 'CWS Cleanrooms')
    >>> d = parse_title("Carel Industries S.p.A. übernimmt die Klingenburg Gruppe")
    >>> d["buyer"], d["target"]
    ('Carel Industries S.p.A.', 'Klingenburg Gruppe')
    >>> parse_title("Erfolgreicher Verkauf eines Schweizer Engineering-Unternehmens") is None
    True
    """
    title = clean_name(title)
    for rx, kind in PATTERNS:
        m = rx.match(title)
        if m:
            parts = {k: clean_name(v) for k, v in m.groupdict().items() if v}
            if any(_ANONYMOUS.search(parts.get(k, "")) for k in ("target", "buyer")):
                return None
            return {"deal_type": kind, **parts}
    return None


_UNNAMED_PARTY = re.compile(
    r"^(?:an?|two|its|the|one)\s+(?:\w+\s+)*?(?:investors?|management(?: team)?|team|family office)\b", re.I)
_CARVE_OUT = re.compile(
    r"^(?:the|its|certain|selected|several|two|three|assets?|swiss subsidiary)\b|\b(?:business|division|divisons?|"
    r"business unit|brands?|stores|entities|subsidiaries|operations|assets|center|centre|service areas)\b", re.I)


def party_kind(name: str) -> str:
    """'unnamed' for a party with no name, 'carve_out' for part of a company.

    >>> party_kind("a financial investor"), party_kind("its management team")
    ('unnamed', 'unnamed')
    >>> party_kind("flour ingredient business"), party_kind("certain assets of Nitto Switzerland")
    ('carve_out', 'carve_out')
    >>> party_kind("Extramet")
    'company'
    """
    if _UNNAMED_PARTY.match(name):
        return "unnamed"
    if _CARVE_OUT.search(name):
        return "carve_out"
    return "company"


def is_anonymous(title: str) -> bool:
    """
    >>> is_anonymous("Erfolgreicher Verkauf eines Schweizer Engineering-Unternehmens")
    True
    >>> is_anonymous("Extramet has been acquired by ADMETOS")
    False
    """
    return bool(_ANONYMOUS.search(title))


# --- Sources --------------------------------------------------------------


def oaklins() -> list[Deal]:
    ids = sorted(
        {m.group(1) for u in sitemap_urls("https://www.oaklins.com/ch/sitemap.xml")
         if (m := re.search(r"/ch/(?:de|en)/deals/(\d+)/", u))},
        key=int,
    )
    deals = []
    for i, deal_id in enumerate(ids, 1):
        url = f"https://www.oaklins.com/ch/en/deals/{deal_id}/"
        print(f"oaklins {i}/{len(ids)} {url}", file=sys.stderr)
        page = fetch(url)
        lines = text_lines(page)
        title = meta(page, "og:title") or (re.search(r"<title>(.*?)</title>", page, re.S) or [None, ""])[1]
        title = html.unescape(title).split(" | ")[0].strip()
        try:
            start = lines.index(title)
        except ValueError:
            start = -1
        date = lines[start + 1] if start >= 0 and start + 1 < len(lines) else ""
        industry = lines[start - 1] if start > 0 else ""
        end = lines.index("Our role in the transaction") if "Our role in the transaction" in lines else start + 4
        desc = " ".join(lines[start + 2:end]).lstrip("— ").strip() if start >= 0 else ""
        role = after(lines, "Our role in the transaction")
        deals.append(Deal(
            source="oaklins_ch", url=url, title=title, date=date, industry=industry,
            service=after(lines, "Service"), advisor_role=role, description=desc,
            text=lines[max(start - 1, 0):end + 2] if start >= 0 else lines,
        ))
    return deals


HELBLING_SKIP = re.compile(r"/news/news/(?:specialty-chemicals-valuation|erfolgreiche-internationale-transaktionen)")


def helbling() -> list[Deal]:
    urls = [u for u in sitemap_urls("https://helbling.ch/sitemap.xml")
            if re.search(r"helbling\.ch/de/(?:referenzprojekte|news/news)/.+", u) and not HELBLING_SKIP.search(u)]
    deals = []
    for i, url in enumerate(urls, 1):
        print(f"helbling {i}/{len(urls)} {url}", file=sys.stderr)
        page = fetch(url)
        # The project itself: from its <h1> (after the navigation menu, which
        # has its own "Dienstleistungen") to the "Weitere Referenzen" teasers.
        # og:title is sometimes an SEO title that differs from the heading.
        h1 = re.search(r"(?is)<h1\b[^>]*>(.*?)</h1>", page)
        if not h1:
            continue
        title = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", h1.group(1)))).strip()
        lines = text_lines(page[h1.end():])
        # Newer pages end in a services block, then "Weitere Referenzen";
        # older ones have no services block and end at the contact.
        ends = [lines.index(m) for m in ("Weitere Referenzen", "Kontakt", "Ihr Kontakt") if m in lines]
        own = lines[: min(ends)] if ends else lines
        stops = [own.index(m) for m in ("Dienstleistungen", "Leistungen", "Unsere Leistungen") if m in own]
        body = [ln for ln in own[: min(stops) if stops else len(own)] if ln not in ("/", title)]
        if "Dienstleistungen" in own:
            service = after(own, "Dienstleistungen")
            if "Mergers & Acquisitions" not in service:
                continue
        elif re.search(r"\bM&A\b", " ".join(body)):
            service = "Mergers & Acquisitions"
        else:
            continue
        deals.append(Deal(
            source="helbling", url=url, title=title, industry=after(own, "Branchen"),
            service=service, description=" ".join(body), text=own,
        ))
    return deals


SOURCES = {"oaklins": oaklins, "helbling": helbling}


# --- Output ---------------------------------------------------------------

CSV_FIELDS = ["source", "status", "usable", "target", "buyer", "seller", "deal_type",
              "target_kind", "buyer_kind", "date", "industry", "service", "title", "url",
              "note", "description"]


def load_overrides() -> dict[str, dict[str, str]]:
    if not OVERRIDES.exists():
        return {}
    with OVERRIDES.open(encoding="utf-8-sig", newline="") as f:
        return {row["url"]: row for row in csv.DictReader(f)}


def resolve(deal: Deal, overrides: dict[str, dict[str, str]]) -> Deal:
    parsed = parse_title(deal.title)
    if (o := overrides.get(deal.url)) is not None:
        for k in ("target", "buyer", "seller", "deal_type", "note"):
            setattr(deal, k, o.get(k, "").strip())
        deal.status = o.get("status", "").strip() or "override"
    elif parsed:
        deal.target = parsed.get("target", "")
        deal.buyer = parsed.get("buyer", "")
        deal.seller = parsed.get("seller", "")
        deal.deal_type = parsed["deal_type"]
        deal.status = "parsed"
    elif deal.source == "oaklins_ch" and not deal.service.startswith("M&A"):
        deal.status = "not_a_deal"  # valuations, fairness opinions, fundraisings
    else:
        deal.status = "anonymous" if is_anonymous(deal.title) else "needs_review"
    if deal.target or deal.buyer:
        deal.target_kind = party_kind(deal.target) if deal.target else "unnamed"
        deal.buyer_kind = party_kind(deal.buyer) if deal.buyer else "unnamed"
        if deal.buyer_kind == "carve_out":
            deal.buyer_kind = "company"
        if o is not None:  # the override's kinds win when given
            deal.target_kind = o.get("target_kind", "").strip() or deal.target_kind
            deal.buyer_kind = o.get("buyer_kind", "").strip() or deal.buyer_kind
    deal.usable = (deal.status in ("parsed", "override")
                   and deal.target_kind == "company" and deal.buyer_kind == "company")
    return deal


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--source", choices=sorted(SOURCES), action="append",
                    help="source to scrape (repeatable; default: all)")
    args = ap.parse_args()
    overrides = load_overrides()
    deals = [resolve(d, overrides) for name in (args.source or SOURCES) for d in SOURCES[name]()]

    with (HERE / "deals.jsonl").open("w", encoding="utf-8") as f:
        for d in deals:
            f.write(json.dumps(asdict(d), ensure_ascii=False) + "\n")
    with (HERE / "deals.csv").open("w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction="ignore")
        w.writeheader()
        for d in deals:
            w.writerow(asdict(d))

    counts: dict[str, int] = {}
    for d in deals:
        counts[f"{d.source}/{d.status}"] = counts.get(f"{d.source}/{d.status}", 0) + 1
    for k, v in sorted(counts.items()):
        print(f"{k}: {v}")


if __name__ == "__main__":
    main()
