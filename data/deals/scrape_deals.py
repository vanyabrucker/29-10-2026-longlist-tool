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
- ``lincoln``: Lincoln International deals whose deal team includes a banker
  in Zurich or Geneva. Lincoln's robots.txt disallows every filtered listing,
  so all ~3,000 deal pages in its sitemap are read (about 50 minutes once).
- ``imap``: IMAP deals filtered to Switzerland (IMAP Switzerland is The
  Corporate Finance Group). Buyer and target are fields of the page's
  tombstone; there is no date.
- ``clairfield``: Clairfield deals tagged with the country Switzerland (any
  office), from its WordPress REST API.
- ``alantra``: Alantra deals of its Swiss office, M&A service only, from its
  WordPress REST API.
- ``forvis_mazars``: Forvis Mazars Switzerland's deal list. Many entries are
  due diligence or valuation work, and parties are in prose: most need a
  row in ``overrides.csv``.
- ``remaco``: the two named sell-side deals on remaco.com (Crawl-delay 10).

Terms: none of these sites forbids scraping or AI use outright (Mergr does,
and is left out); several reserve reproduction of their content, and
Alantra's terms forbid reuse "for public or commercial purposes" without
permission. Keep the output internal.

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
import urllib.error
import urllib.request
from dataclasses import asdict, dataclass, field
from pathlib import Path

HERE = Path(__file__).resolve().parent
CACHE = HERE / ".cache"
OVERRIDES = HERE / "overrides.csv"
USER_AGENT = "Mozilla/5.0 (compatible; helios-deals-research/0.1)"
DELAY_S = 1.0

_last_fetch = 0.0


def fetch(url: str, delay: float = DELAY_S) -> str:
    """The page at ``url``, from the cache when it was fetched before."""
    global _last_fetch
    CACHE.mkdir(exist_ok=True)
    path = CACHE / (hashlib.sha1(url.encode()).hexdigest() + ".html")
    if path.exists():
        return path.read_text(encoding="utf-8")
    wait = delay - (time.monotonic() - _last_fetch)
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
    status: str = ""  # parsed | override | needs_review | anonymous | not_a_deal | duplicate
    target_kind: str = ""  # company | carve_out | unnamed
    buyer_kind: str = ""  # company | person | unnamed
    usable: bool = False  # a named company bought by a named buyer
    date: str = ""  # as the page gives it, e.g. "October 2025"
    industry: str = ""
    service: str = ""
    advisor_role: str = ""
    description: str = ""
    note: str = ""
    summary: str = ""  # a one-sentence summary, read when the title has no parties
    target_hq: str = ""  # where the page gives it, e.g. "Rüti, Schweiz"
    buyer_hq: str = ""
    target_name: str = ""  # the target's name from its own field; wins over a parsed one
    text: list[str] = field(default_factory=list, repr=False)


# --- Title patterns -------------------------------------------------------

_ART = r"(?:(?:die|der|den|das|des|the)\s+)?"
_STAKE = (r"(?:(?:an?|the|its|their)\s+)?(?:remaining\s+)?(?:\d+(?:\.\d+)?\s?%(?:-|\s+))?"
          r"(?:(?:majority|minority|controlling|significant|strategic)\s+)?"
          r"(?:stake|interest|shareholding|shares)\s+(?:in|of)\s+"
          r"|\d+\s?%\s+of\s+|a majority of\s+")
_ACQUIRED = r"(?:acquired|aquired|bought|purchased|taken over)"
_SOLD = r"(?:has (?:successfully )?sold|sells|have sold)"
_FROM = r"(?: from (?P<seller>.+))?"
_ON = r"(?:on|in|with respect to)"

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
        # German (boutiques: SMC, Vollmar, Business Broker, Gut CF)
        (rf"^.*?\b(?:Eigentümer\w*|Aktionär\w*|Verkäufer\w*|Gesellschafter\w*|Inhaber\w*) (?:der |des |von )(?P<target>.+?) "
         rf"(?:beim|bei dem|im) (?:erfolgreichen )?Verkauf(?:sprozess)? an {_ART}(?P<buyer>.+)$", "acquisition"),
        (rf"^(?P<target>.+?) (?:wird|wurde) (?:erfolgreich )?an {_ART}(?P<buyer>.+?) verkauft$", "acquisition"),
        (rf"^(?P<target>.+?) (?:wird|wurde) Teil (?:von |der |des |einer )?(?P<buyer>.+)$", "acquisition"),
        (rf"^(?P<target>.+?) schliesst sich {_ART}(?P<buyer>.+?) an$", "acquisition"),
        (rf"^(?P<seller>.+?) verkauft(?:e)? {_ART}(?P<target>.+?) an {_ART}(?P<buyer>.+)$", "sale"),
        (rf"^(?P<buyer>.+?) (?:erwirbt|erwarb|kauft) (?:eine |die )?(?:Mehrheits|Minderheits)?(?:beteiligung|Beteiligung) an {_ART}(?P<target>.+)$", "investment"),
        (rf"^(?P<buyer>.+?) (?:erwirbt|erwarb|kauft) {_ART}(?P<target>.+)$", "acquisition"),
        (rf"^(?P<buyer>.+?) hat {_ART}(?P<target>.+?) (?:übernommen|erworben|gekauft)$", "acquisition"),
        # Bare past tense (Clairfield, Forvis Mazars summaries)
        (r"^(?P<target>.+?) (?:was )?sold to (?P<buyer>.+)$", "acquisition"),
        (rf"^(?P<seller>.+?) sold (?:its |their )?(?:{_STAKE})?(?P<target>.+?) to (?P<buyer>.+)$", "sale"),
        (rf"^(?P<buyer>.+?) (?:has |have )?(?:acquired|bought|took over) (?:{_STAKE})?(?P<target>.+?){_FROM}$", "acquisition"),
        (r"^(?P<target>.+?) (?:joins?|has joined|became part of) (?P<buyer>.+)$", "acquisition"),
    ]
]

# "<Advisor> advises <client> on ...": the advisor is cut off first and the
# rest is read with these patterns, so the client's role decides who is who.
ADVISOR_PREFIX = re.compile(
    r"^(?:(?:Forvis Mazars|Mazars|Alantra|Alatra|Clairfield(?: International)?|Lincoln International|Remaco|"
    r"Proventis Partners|IFBC|Wineus|SMC Corporate Finance|Gut Corporate Finance|Vollmar & Partners?)\s+)?"
    r"(?:(?:has )?(?:successfully )?(?:advises|advised|supported|assisted)"
    r"|(?:successfully )?(?:acts|acted) as .+? (?:to|for))\s+"
    r"|^(?:Exclusive |Sole |Lead )?(?:M&A|financial|sell-side|buy-side) advis[oe]r to (?:the )?",
    re.I)
ADVISED: list[tuple[re.Pattern[str], str]] = [
    (re.compile(p, re.I), t)
    for p, t in [
        (rf"^(?:the )?(?:founding )?(?:shareholders|founders|owners) of (?P<target>.+?)(?:, represented by [^,]+,)? "
         rf"{_ON} (?:the |its |their )?(?:successful )?(?:sale|combination|merger)"
         rf"(?: of (?:their|its) (?:remaining )?(?:\d+\s?% )?stake| of the company)? (?:to|with) (?P<buyer>.+)$", "acquisition"),
        (rf"^(?P<target>.+?) {_ON} (?:the |its )?sale of an? (?:\d+\s?%[- ]?)?(?:\w+ )?stake to (?P<buyer>.+)$", "investment"),
        (r"^(?P<target>.+?) in selling an? (?:\w+ )?stake to (?P<buyer>.+)$", "investment"),
        (rf"^(?P<target>.+?) {_ON} (?:its|the) (?:successful )?sale (?:of the company )?to (?P<buyer>.+)$", "acquisition"),
        (rf"^(?P<seller>.+?) {_ON} the (?:sale|disposal|divestiture) of (?:its |their )?(?:{_STAKE})?(?P<target>.+?) to (?P<buyer>.+)$", "sale"),
        (rf"^(?P<buyer>.+?) {_ON} (?:its |the )?(?:acquisition|purchase|takeover) of (?:{_STAKE})?(?P<target>.+?){_FROM}$", "acquisition"),
        (rf"^(?P<buyer>.+?) {_ON} its investment in (?P<target>.+)$", "investment"),
        (rf"^(?P<target>.+?) {_ON} (?:an? |its )?(?:minority |majority )?(?:growth )?investment (?:by|from) (?P<buyer>.+)$", "investment"),
        (rf"^(?P<target>.+?) {_ON} (?:its|the) (?:merger|combination) with (?P<buyer>.+)$", "merger"),
        (rf"^(?P<target>.+?) {_ON} combining forces with (?P<buyer>.+)$", "merger"),
        (rf"^(?P<target>.+?) {_ON} the (?:recommended |public )?(?:tender offer|takeover bid) (?:filed |launched )?by (?P<buyer>.+)$", "acquisition"),
    ]
]

# Descriptions trailing a party name: ", a portfolio company of …",
# ", creating …", " for CHF 124m".
_TRAILER = re.compile(
    r",\s+(?:an?|the)\s+(?:\w+\s+)*?(?:portfolio company|subsidiary|company|group|fund|leader|provider)\b.*$"
    r"|,\s+(?:creating|to create|which|who)\b.*$|\s+(?:to create|creating)\b.*$"
    r"|\s+for\s+(?:CHF|EUR|USD|US\$|GBP)\s?[\d.,]+\s*(?:m|bn|million|billion)?\b.*$",
    re.I)


def trim_party(name: str) -> str:
    """A party name without a trailing description.

    >>> trim_party("ImaOne, a portfolio company of Bpifrance and Eurazeo")
    'ImaOne'
    >>> trim_party("Persán, creating a leading global CDMO")
    'Persán'
    >>> trim_party("SSM Textile Machinery Division from Schweiter for CHF 124m")
    'SSM Textile Machinery Division from Schweiter'
    >>> trim_party("Luxoft Holding, Inc")
    'Luxoft Holding, Inc'
    """
    return clean_name(_TRAILER.sub("", name))

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
    name = re.sub(r"\s+", " ", name.strip().strip("„“\"'’").rstrip(",;:").strip())
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
    >>> d = parse_title("Alantra advises Migros on the sale of Mibelle Group to Persán, creating a CDMO")
    >>> d["seller"], d["target"], d["buyer"]
    ('Migros', 'Mibelle Group', 'Persán')
    >>> d = parse_title("Alantra advises Vaudoise on the acquisition of a majority stake in Procimmo")
    >>> d["buyer"], d["target"]
    ('Vaudoise', 'Procimmo')
    >>> d = parse_title("Alantra advised Hoegger AG on its sale to Provisur Technologies")
    >>> d["target"], d["buyer"]
    ('Hoegger AG', 'Provisur Technologies')
    >>> d = parse_title("HomeToGo acquired Interhome from Migros")
    >>> d["buyer"], d["target"], d["seller"]
    ('HomeToGo', 'Interhome', 'Migros')
    >>> parse_title("Publibike sold to VisionEdgeOne")["buyer"]
    'VisionEdgeOne'
    >>> d = parse_title("DECALIA Capital and founding shareholders have sold MediGroup to ImaOne, a portfolio company of Bpifrance")
    >>> d["target"], d["buyer"]
    ('MediGroup', 'ImaOne')
    """
    title = clean_name(title)
    patterns = PATTERNS
    if m := ADVISOR_PREFIX.match(title):
        title, patterns = title[m.end():], ADVISED
    for rx, kind in patterns:
        m = rx.match(title)
        if m:
            parts = {k: trim_party(v) for k, v in m.groupdict().items() if v}
            if any(_ANONYMOUS.search(parts.get(k, "")) for k in ("target", "buyer")):
                return None
            return {"deal_type": kind, **parts}
    return None


_UNNAMED_PARTY = re.compile(
    r"^(?:(?:an?|two|its|the|one)\s+(?:\w+\s+)*?(?:investors?|management(?: team)?|team|family office)\b"
    r"|management(?: team)?$)", re.I)
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


def fetch_json(url: str, delay: float = DELAY_S) -> object:
    return json.loads(fetch(url, delay))


def strip_tags(fragment: str) -> str:
    """
    >>> strip_tags("<p>A &amp; <b>B</b></p>\\n<p>C</p>")
    'A & B C'
    """
    text = html.unescape(re.sub(r"<[^>]+>", " ", fragment)).replace("\xa0", " ")
    return re.sub(r"\s+", " ", text).strip()


def first(pattern: str, page: str) -> str:
    """The text of the first match of ``pattern``'s group 1, tags removed."""
    m = re.search(pattern, page, re.S | re.I)
    return strip_tags(m.group(1)) if m else ""


def lincoln() -> list[Deal]:
    maps = [u for u in sitemap_urls("https://www.lincolninternational.com/sitemap_index.xml")
            if "transactions-sitemap" in u]
    urls = list(dict.fromkeys(  # a deal can be listed twice across the sitemaps
        u for m in maps for u in sitemap_urls(m) if "/transactions/" in u.rstrip("/").rsplit("/", 1)[0] + "/"))
    deals, broken = [], []
    for i, url in enumerate(urls, 1):
        if i % 100 == 0:
            print(f"lincoln {i}/{len(urls)}", file=sys.stderr)
        try:
            page = fetch(url)
        except urllib.error.HTTPError as e:
            if e.code < 500:
                raise
            broken.append(f"{e.code} {url}")  # a deal page broken on Lincoln's side
            continue
        # The deal team's offices: "<h3>Name</h3></a> <p><p>Title</p> Zurich </p>".
        team = page[page.find('class="container team"'):]
        offices = {o.strip() for o in re.findall(r"</h3>\s*</a>\s*<p>\s*<p>.*?</p>\s*([^<]+?)\s*</p>", team, re.S)}
        if not offices & {"Zurich", "Zürich", "Geneva"}:
            continue
        title = first(r"<h1[^>]*>(.*?)</h1>", page)
        date = (re.search(r'"datePublished":"(\d{4}-\d{2}-\d{2})', page) or [None, ""])[1]
        body = page[page.find("</h1>"):page.find('class="container team"')]
        deals.append(Deal(
            source="lincoln", url=url, title=title, date=date or first(r'class="[^"]*close-year[^"]*">(.*?)</div>', page),
            industry=first(r'class="[^"]*industries[^"]*">(.*?)</div>', page),
            description=strip_tags(re.split(r"Related Perspectives", body)[0])[:3000],
            note="offices: " + ", ".join(sorted(offices)),
        ))
    if broken:
        print(f"lincoln: {len(broken)} pages failed on the server and were skipped:\n  "
              + "\n  ".join(broken), file=sys.stderr)
    return deals


IMAP_SWITZERLAND = 13327


def imap() -> list[Deal]:
    links: list[str] = []
    for page_no in range(1, 20):
        page = fetch(f"https://www.imap.com/en/ajax/transactions?location={IMAP_SWITZERLAND}&page={page_no}")
        new = [u for u in dict.fromkeys(re.findall(r'href="(/en/transactions/[^"]*~t)"', page)) if u not in links]
        if not new:
            break
        links += new
    deals = []
    for path in links:
        url = "https://www.imap.com" + path
        page = fetch(url)
        box = page[page.find('class="tombstone-box"'):]
        mediation = first(r'class="tombstone-box-mediation[^"]*">(.*?)</div>', box)
        kind = ("investment" if re.search(r"capital|financ|invest|raise", mediation, re.I)
                else "merger" if re.search(r"merger", mediation, re.I) else "acquisition")
        h1 = page.find("<h1")
        deals.append(Deal(
            source="imap", url=url, title=first(r"<h1[^>]*>(.*?)</h1>", page[h1:]) if h1 >= 0 else "",
            target=first(r'class="seller">\s*<div class="name">(.*?)</div>', box),
            buyer=first(r'class="buyer">\s*<div class="name">(.*?)</div>', box),
            deal_type=kind,
            industry=first(r'class="tombstone-box-headline[^"]*">(.*?)</div>', box),
            advisor_role=mediation,
            description=strip_tags(page[h1:page.find("Find out more", h1)])[:3000] if h1 >= 0 else "",
        ))
    return deals


CLAIRFIELD_SWITZERLAND = 49  # country taxonomy: deals involving Switzerland, any office


def clairfield() -> list[Deal]:
    items = fetch_json("https://www.clairfield.com/wp-json/wp/v2/transaction"
                       f"?country={CLAIRFIELD_SWITZERLAND}&per_page=100"
                       "&_fields=id,date,link,title,content,acf,class_list")
    deals = []
    for it in items:  # type: ignore[union-attr]
        acf = it.get("acf") or {}
        sectors = [c.removeprefix("sector-") for c in it.get("class_list", []) if c.startswith("sector-")]
        deals.append(Deal(
            source="clairfield", url=it["link"], title=strip_tags(it["title"]["rendered"]),
            date=it["date"][:10], industry=", ".join(sectors),
            advisor_role=strip_tags(str(acf.get("transaction_text") or "")),
            description=strip_tags(str(acf.get("intro_text") or "") + " " + it["content"]["rendered"])[:3000],
        ))
    return deals


ALANTRA_SWITZERLAND, ALANTRA_MA = 30, 94  # country (= office) and ib-service taxonomies


def alantra() -> list[Deal]:
    deals = []
    for page_no in range(1, 10):
        items = fetch_json("https://www.alantra.com/wp-json/wp/v2/ib-transaction"
                           f"?country={ALANTRA_SWITZERLAND}&ib-service={ALANTRA_MA}&per_page=100&page={page_no}"
                           "&_fields=id,date,link,title,content")
        for it in items:  # type: ignore[union-attr]
            deals.append(Deal(
                source="alantra", url=it["link"], title=strip_tags(it["title"]["rendered"]),
                date=it["date"][:10], service="M&A",
                description=strip_tags(it["content"]["rendered"])[:3000],
            ))
        if len(items) < 100:  # type: ignore[arg-type]
            break
    return deals


def forvis_mazars() -> list[Deal]:
    listing = fetch("https://www.forvismazars.com/ch/en/insights/deals")
    deals = []
    for card in re.findall(r'(?s)<article class="Card.*?</article>', listing):
        href = (re.search(r'class="Card-title">\s*<a href="([^"]+)"', card) or [None, ""])[1]
        if not href:
            continue
        url = "https://www.forvismazars.com" + href
        page = fetch(url)
        intro = first(r'class="Article--intro[^"]*">(.*?)</div>', page)
        date, _, summary = intro.partition(" | ") if " | " in intro else ("", "", intro)
        deals.append(Deal(
            source="forvis_mazars", url=url, title=first(r'class="TopHero-title">(.*?)</h1>', page)
            or first(r'class="Card-title">(.*?)</h4>', card),
            date=date.strip() or first(r'class="Card-headerDatePublished">(.*?)</span>', card),
            industry=first(r'class="Card-tag">(.*?)</div>', card),
            description=(summary + " " + first(r'class="Article--content[^"]*">(.*?)</div>', page)).strip()[:3000],
            summary=summary,
        ))
    return deals


PROVENTIS_TAGS = (257, 283)  # "Switzerland", "Zurich" (English posts)


def proventis() -> list[Deal]:
    seen: dict[str, dict] = {}
    for tag in PROVENTIS_TAGS:
        for it in fetch_json(f"https://proventis.com/wp-json/wp/v2/transactions?tags={tag}&per_page=100"
                             "&_fields=id,date,link,title,content"):  # type: ignore[union-attr]
            seen.setdefault(it["link"], it)
    deals = []
    for url, it in seen.items():
        page = fetch(url)  # the deal year is only in the page (WP dates are a migration date)
        deals.append(Deal(
            source="proventis", url=url, title=strip_tags(it["title"]["rendered"]),
            date=first(r'<span class="date">(.*?)</span>', page),
            service=first(r"<h3>\s*([^<]+?)\s*<br\s*/?>\s*<span class=\"date\">", page),
            description=strip_tags(it["content"]["rendered"])[:3000],
        ))
    return deals


def ifbc() -> list[Deal]:
    deals, seen = [], set()
    for page_no in range(1, 60):
        page = fetch(f"https://www.ifbc.ch/en/clients?4f3765d4_page={page_no}")
        items = re.findall(r'(?s)<div role="listitem" class="w-dyn-item">(.*?)(?=<div role="listitem"|</div></div></div></div>\s*<div role="navigation")', page)
        if not items:
            break
        for item in items:
            services = [strip_tags(s) for s in re.findall(r'fs-cmsfilter-field="Service" class="text-block-10">(.*?)</div>', item)]
            summary = first(r'<p class="paragraph-2">(.*?)</p>', item)
            slug = (re.search(r'href="(/en/clients/[^"]+)"', item) or [None, ""])[1]
            key = slug or summary
            if "M&A" not in services or key in seen:
                continue
            seen.add(key)
            deals.append(Deal(
                source="ifbc", url="https://www.ifbc.ch" + slug if slug else f"https://www.ifbc.ch/en/clients#{key[:60]}",
                title=summary, summary=summary, date=first(r'class="text-block-7">(.*?)</div>', item),
                industry=", ".join(strip_tags(s) for s in re.findall(r'fs-cmsfilter-field="Sektor" class="text-block-9">(.*?)</div>', item)),
                service="M&A", description=summary,
            ))
    return deals


REMACO = ("beurret-bailly-widmer-auktionen-ag", "klima-immobilien-und-beteiligungen-ag")


def remaco() -> list[Deal]:
    deals = []
    for slug in REMACO:
        for it in fetch_json(f"https://remaco.com/wp-json/wp/v2/posts?slug={slug}&_fields=date,link,title,content",
                             delay=10):  # type: ignore[union-attr]
            deals.append(Deal(source="remaco", url=it["link"], title=strip_tags(it["title"]["rendered"]),
                              date=it["date"][:10], description=strip_tags(it["content"]["rendered"])[:3000]))
    return deals


def slug(text: str, limit: int = 50) -> str:
    """A stable URL fragment for a deal listed on a page without its own URL.

    >>> slug("Zeochem (Rüti, Schweiz)")
    'zeochem-ruti-schweiz'
    """
    import unicodedata
    ascii_text = unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()
    return re.sub(r"[^a-z0-9]+", "-", ascii_text.lower()).strip("-")[:limit].rstrip("-")


def detail_page(source: str, url: str, delay: float = DELAY_S, **fields: str) -> Deal:
    """A deal from a page whose <h1> is the deal's headline."""
    page = fetch(url, delay)
    h1 = re.search(r"(?is)<h1\b[^>]*>(.*?)</h1>", page)
    title = strip_tags(h1.group(1)) if h1 else meta(page, "og:title")
    body = page[h1.end():] if h1 else page
    body = re.split(r"(?i)<footer\b", body)[0]
    return Deal(source=source, url=url, title=title, description=" ".join(text_lines(body))[:3000], **fields)


_RAMUS_VERB = re.compile(r"^(?:übernimmt|erwerben|erwirbt|beteiligen sich an|beteiligt sich an|fusioniert mit|"
                         r"schliesst sich zusammen mit|schliessen sich zusammen|wird verkauft an|verkauft)\b", re.I)


def ramus() -> list[Deal]:
    """Ramus & Company's references: one block per deal, ending with the year.

    A block reads: party A, "(place)", A's description, a verb, party B,
    "(place)", B's description, category, year. Only M&A categories are kept.
    """
    url = "https://www.ramuscompany.com/referenzen/"
    lines = text_lines(fetch(url))
    lines = lines[lines.index("Zurücksetzen") + 1:]
    deals, start = [], 0
    for j, line in enumerate(lines):
        if not re.fullmatch(r"(?:19|20)\d\d", line):
            continue
        block, start = lines[start:j + 1], j + 1
        category = block[-2] if len(block) >= 2 else ""
        if not re.match(r"M&A|Strategic Partnering", category):
            continue
        verb_at = next((k for k, ln in enumerate(block) if _RAMUS_VERB.match(ln)), None)
        if verb_at is None:
            continue
        verb = block[verb_at]
        a, b = block[:verb_at], block[verb_at + 1:-2]

        def party(part: list[str]) -> tuple[str, str]:
            name = part[0] if part else ""
            place = part[1].strip("()") if len(part) > 1 and part[1].startswith("(") else ""
            return name, place

        (a_name, a_hq), (b_name, b_hq) = party(a), party(b)
        deal = Deal(source="ramus", url=f"{url}#{slug(a_name, 30)}--{slug(b_name, 30)}--{line}",
                    title=" ".join(block[:-2]),
                    date=line, service=category, description=" ".join(block))
        if re.match(r"übernimmt|erw|beteilig", verb, re.I):
            deal.buyer, deal.buyer_hq, deal.target, deal.target_hq = a_name, a_hq, b_name, b_hq
            deal.deal_type = "investment" if "beteilig" in verb else "acquisition"
        elif verb.startswith("wird verkauft an"):
            deal.target, deal.target_hq, deal.buyer, deal.buyer_hq = a_name, a_hq, b_name, b_hq
            deal.deal_type = "acquisition"
        elif re.match(r"fusioniert|schliess", verb, re.I):
            deal.target, deal.target_hq, deal.buyer, deal.buyer_hq = a_name, a_hq, b_name, b_hq
            deal.deal_type = "merger"
        else:  # "verkauft …": who is target and who buyer depends on the rest of the line
            deal.note = f"verb: {verb}"
        deals.append(deal)
    return deals


def smc() -> list[Deal]:
    url = "https://smc-cf.ch/referenzen/"
    page = fetch(url)
    deals = []
    for item in re.findall(r"(?s)<div class='cq-ihover-text'>(.*?)</div></div></a>", page):
        descs = [strip_tags(d) for d in re.findall(r"(?s)<p class='cq-ihover-desc'>(.*?)</p>", item)]
        if descs:
            key = slug(descs[0], 80)
            n = sum(d.url.split("#")[1].startswith(key) for d in deals)
            deals.append(Deal(source="smc", url=f"{url}#{key}{f'-{n + 1}' if n else ''}", title=descs[0],
                              description=" ".join(descs)))
    return deals


def vollmar() -> list[Deal]:
    urls = sitemap_urls("https://vollmar.partners/references-sitemap.xml")
    return [detail_page("vollmar", u) for u in urls if "/references/" in u]


def wineus() -> list[Deal]:
    page = fetch("https://www.wineus.ch/ueber-uns/news-und-referenzen")
    paths = dict.fromkeys(re.findall(r'href="(/ueber-uns/news-und-referenzen/news-detail/[^"]+)"', page))
    return [detail_page("wineus", "https://www.wineus.ch" + p) for p in paths]


def gut_cf() -> list[Deal]:
    page = fetch("https://www.gcf.swiss/de/referenzen/transaktionen/")
    deals = []
    for path, alt in re.findall(r'<a href="(/de/referenzen/transaktionen/[^"]+)">\s*<img[^>]+alt="([^"]*)"', page):
        deal = detail_page("gut_cf", "https://www.gcf.swiss" + path)
        deal.summary = html.unescape(alt).strip()
        deals.append(deal)
    return deals


def business_broker() -> list[Deal]:
    """Business Broker's succession sales: name, headline, sector, revenue, year."""
    url = "https://www.businessbroker.ch/de/firma-verkaufen/referenzen"
    page = fetch(url)
    lines = text_lines(page)
    links = list(dict.fromkeys(re.findall(r'href="((?:https://www\.businessbroker\.ch)?/de/firma-verkaufen/referenzen/\d+/[^"]+)"', page)))
    deals = []
    for j, line in enumerate(lines):
        if line != "Firmenname" or j + 1 >= len(lines):
            continue
        name = lines[j + 1]
        # The headline is the line(s) just before the "Firmenname" label.
        headline = lines[j - 1] if j and lines[j - 1] != "-->" else lines[j - 2]
        fields = dict(zip(lines[j:j + 10:2], lines[j + 1:j + 11:2]))
        link = next((u for u in links if re.sub(r"\W", "", name.lower())[:12] in re.sub(r"\W", "", u.lower())), "")
        deal_url = ((link if link.startswith("http") else "https://www.businessbroker.ch" + link)
                    if link else f"{url}#{re.sub(r'[^a-z0-9]+', '-', name.lower())}")  # keys in overrides.csv
        # Two references can match one detail link (same company sold twice).
        n = sum(d.url.split("#")[0] == deal_url.split("#")[0] for d in deals)
        deals.append(Deal(
            source="business_broker", url=f"{deal_url}#{n + 1}" if n and "#" not in deal_url else deal_url,
            title=headline, summary=headline, date=fields.get("Jahr", ""),
            industry=" / ".join(x for x in (fields.get("Branche", ""), fields.get("Bereich", "")) if x),
            note=f"revenue: {fields['Umsatz']}" if fields.get("Umsatz") else "",
            description=f"{name}: {headline}", target_hq="Schweiz", target_name=name,
        ))
    return deals


SOURCES = {"oaklins": oaklins, "helbling": helbling, "lincoln": lincoln, "imap": imap,
           "clairfield": clairfield, "alantra": alantra, "forvis_mazars": forvis_mazars,
           "proventis": proventis, "ifbc": ifbc, "remaco": remaco, "ramus": ramus, "smc": smc,
           "vollmar": vollmar, "wineus": wineus, "gut_cf": gut_cf, "business_broker": business_broker}


# --- Output ---------------------------------------------------------------

CSV_FIELDS = ["source", "status", "usable", "target", "buyer", "seller", "deal_type",
              "target_kind", "buyer_kind", "target_hq", "buyer_hq", "date", "industry",
              "service", "title", "url", "note", "description"]


def load_overrides() -> dict[str, dict[str, str]]:
    if not OVERRIDES.exists():
        return {}
    with OVERRIDES.open(encoding="utf-8-sig", newline="") as f:
        return {row["url"]: row for row in csv.DictReader(f)}


def sentences(text: str, n: int = 3) -> list[str]:
    """The first ``n`` sentences of ``text``.

    >>> sentences("Acme AG bought Beta S.p.A. in 2020. It was a sale. Gamma is next.", 2)
    ['Acme AG bought Beta S.p.A. in 2020', 'It was a sale']
    """
    parts = re.split(r"(?<=[\w)][\w)])\.\s+(?=[A-Z])", text.strip())
    return [clean_name(p) for p in parts[:n] if p.strip()]


def parse_deal(deal: Deal) -> tuple[dict[str, str] | None, str]:
    """Parties from the title, else the summary, else the description's first
    sentences; and a note saying where they came from when not the title."""
    if parsed := parse_title(deal.title):
        return parsed, ""
    if deal.summary and (parsed := parse_title(re.split(r",\s+which\b", deal.summary)[0])):
        return parsed, "parties from the summary"
    for s in sentences(deal.description):
        if parsed := parse_title(re.split(r",\s+which\b", s)[0]):
            return parsed, "parties from the text"
    return None, ""


def resolve(deal: Deal, overrides: dict[str, dict[str, str]]) -> Deal:
    structured = bool(deal.target and deal.buyer)  # IMAP's tombstone fields
    parsed, where = (None, "") if structured else parse_deal(deal)
    if (o := overrides.get(deal.url)) is not None:
        for k in ("target", "buyer", "seller", "deal_type", "note"):
            setattr(deal, k, o.get(k, "").strip())
        deal.status = o.get("status", "").strip() or "override"
    elif structured:
        deal.status = "parsed"
    elif parsed:
        deal.note = "; ".join(x for x in (deal.note, where) if x)
        deal.target = deal.target_name or parsed.get("target", "")
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
    # A named person (buyer_kind "person") or a buyback isn't a company to find.
    deal.usable = (deal.status in ("parsed", "override")
                   and deal.target_kind == "company" and deal.buyer_kind == "company"
                   and deal.target.casefold() != deal.buyer.casefold())
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
