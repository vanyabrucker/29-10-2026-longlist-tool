"""Turn raw cell values into normalised values per data-point type.

Each value is stored twice: as written (`raw`) and normalised (`value`, a small
JSON object). Values that can't be parsed are reported as errors in the review
instead of guessed. Values that parse but look unlikely (a company founded
before 1800, or in a future year) are imported with a warning (`warnings`), so
the reviewer can check them. Placeholders like "n/a" or "Not disclosed" are
empty.
"""

import re
from datetime import date, timedelta
from typing import Any

import pycountry

from app.catalogue import DataPoint
from app.ingest.platforms import shared_host

EMPTY = re.compile(
    r"^\s*(n/?a|na|none|null|-+|–|—|\?|not disclosed|undisclosed|k\.?\s?a\.?|"
    r"keine angabe|tbd|unknown)\s*$",
    re.IGNORECASE,
)

CURRENCIES = {
    "€": "EUR", "eur": "EUR", "euro": "EUR", "chf": "CHF", "fr.": "CHF",
    "sfr": "CHF", "$": "USD", "usd": "USD", "us$": "USD", "£": "GBP", "gbp": "GBP",
    "sek": "SEK", "nok": "NOK", "dkk": "DKK", "pln": "PLN", "jpy": "JPY",
}
MULTIPLIERS = [
    (r"(bn|b|billion|mrd\.?|milliarden?)", 1e9),
    (r"(m|mn|mm|mio\.?|million(en)?)", 1e6),
    (r"(k|thousand|tsd\.?|tausend)", 1e3),
]

# Common spellings of enum options (case-insensitive), beyond the options
# themselves. Unmatched values go to the LLM in the report step.
ENUM_ALIASES = {
    "private equity": "PE", "growth equity": "PE", "buyout": "PE",
    "venture capital": "VC", "venture": "VC", "corporate venture capital": "CVC",
    "corporate vc": "CVC", "family office": "Family Office", "fo": "Family Office",
    "angel": "Angel Investor", "business angel": "Angel Investor",
    "high net worth individual": "HNWI", "private investor": "HNWI",
    "strategic": "Strategic Investor", "corporate": "Strategic Investor",
    "strategic buyer": "Strategic Investor",
    "strategisch": "Strategic", "finanzinvestor": "Financial",
    "financial investor": "Financial", "financial buyer": "Financial",
    "lead": "Lead investor", "co-investor": "Co-investor",
    "family-owned": "Founder/family", "family": "Founder/family",
    "founder": "Founder/family", "public": "Listed", "listed company": "Listed",
    "subsidiary": "Corporate subsidiary",
    "german": "DE", "deutsch": "DE", "english": "EN", "englisch": "EN",
    "french": "FR", "französisch": "FR", "italian": "IT", "italienisch": "IT",
    "spanish": "ES",
}
TRUE = {"yes", "y", "ja", "j", "true", "x", "1", "✓", "✔", "wahr", "oui", "si"}
FALSE = {"no", "n", "nein", "false", "0", "falsch", "non"}
COUNTRY_NAMES = {
    "deutschland": "DE", "schweiz": "CH", "suisse": "CH", "svizzera": "CH",
    "österreich": "AT", "oesterreich": "AT", "uk": "GB", "england": "GB",
    "usa": "US", "u.s.": "US", "u.s.a.": "US", "niederlande": "NL",
    "frankreich": "FR", "italien": "IT", "spanien": "ES", "schweden": "SE",
}
MONTHS = {m: i for i, m in enumerate(
    ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov",
     "dec"], start=1)}
MONTHS.update({"mär": 3, "mrz": 3, "mai": 5, "okt": 10, "dez": 12})


class Invalid(ValueError):
    pass


def is_empty(raw: Any) -> bool:
    return raw is None or (isinstance(raw, str) and (not raw.strip() or EMPTY.match(raw)))


def parse_number(text: str) -> float:
    """'1'662', '1.662,5', '1,662.5', '2.1' → float."""
    s = re.sub(r"[\s'’]", "", text)
    if not re.search(r"\d", s):
        raise Invalid(f"no number in {text!r}")
    s = re.sub(r"[^\d.,-]", "", s)
    if "," in s and "." in s:
        # The last separator is the decimal one.
        s = s.replace(".", "").replace(",", ".") if s.rfind(",") > s.rfind(".") else s.replace(",", "")
    elif "," in s:
        head, _, tail = s.rpartition(",")
        # "1,662" is thousands; "2,5" is a decimal comma.
        s = s.replace(",", "") if len(tail) == 3 and head else s.replace(",", ".")
    elif s.count(".") > 1:
        s = s.replace(".", "")
    try:
        return float(s)
    except ValueError as e:
        raise Invalid(f"not a number: {text!r}") from e


# A bound is a whole number: digits, optionally grouped in threes by one
# separator (1'001, 1’001, 1,001, 1 001, 1.001). A dot is only ever a thousands
# separator here, so 1.5 or 1.0001 are errors, never guesses; so is 1k.
_BOUND = re.compile(r"\d+|\d{1,3}(['’,. ])\d{3}(?:\1\d{3})*")
_ISO_DATE = re.compile(r"\d{4}-\d{2}-\d{2}(?:[t ][\d:.]+)?")
_DATE_HINT = "looks like a date — Excel may have turned a range like 1-10 into a date"


def _bound(text: str, raw: Any) -> int:
    s = text.strip()
    if not _BOUND.fullmatch(s):
        raise Invalid(f"not a whole number or range: {raw!r}")
    return int(re.sub(r"\D", "", s))


def int_range(raw: Any) -> dict:
    """'37', '11-50', '201 bis 500', '10,000+', '>10000', 'über 1000', '<10',
    'up to 10', 'bis zu 10' → {"low", "high"}. Anything else is Invalid."""
    if isinstance(raw, date):
        raise Invalid(_DATE_HINT)
    if isinstance(raw, bool):
        raise Invalid(f"not a whole number or range: {raw!r}")
    if isinstance(raw, (int, float)):
        if raw != int(raw) or raw < 0:
            raise Invalid(f"not a whole number: {raw!r}")
        return {"low": int(raw), "high": int(raw)}
    text = re.sub(r"\s+", " ", str(raw)).strip().lower()
    if _ISO_DATE.fullmatch(text):
        raise Invalid(_DATE_HINT)
    if m := re.fullmatch(r"(?:>|über|mehr als)\s*(.+)", text):
        return {"low": _bound(m[1], raw) + 1, "high": None}
    if m := re.fullmatch(r"<\s*(.+)", text):
        high = _bound(m[1], raw) - 1
        if high < 0:
            raise Invalid(f"{raw!r} leaves no possible number")
        return {"low": None, "high": high}
    if m := re.fullmatch(r"(.+?)\s*\+", text):
        return {"low": _bound(m[1], raw), "high": None}
    if m := re.fullmatch(r"(?:up to|bis zu)\s+(.+)", text):
        return {"low": None, "high": _bound(m[1], raw)}
    if m := re.fullmatch(r"(.+?)\s*(?:[-–—]|\bto\b|\bbis\b)\s*(.+)", text):
        low, high = _bound(m[1], raw), _bound(m[2], raw)
        if low > high:
            raise Invalid(f"{raw!r} runs backwards")
        return {"low": low, "high": high}
    n = _bound(text, raw)
    return {"low": n, "high": n}


def range_text(value: dict) -> str:
    low, high = value["low"], value["high"]
    if low is None:
        return f"up to {high}"
    if high is None:
        return f"{low}+"
    return str(low) if low == high else f"{low}–{high}"


def money(raw: Any) -> dict:
    if isinstance(raw, (int, float)):
        return {"amount": float(raw), "currency": None}
    text = str(raw).strip()
    lower = text.lower()
    currency = next(
        (code for sym, code in sorted(CURRENCIES.items(), key=lambda kv: -len(kv[0]))
         if (sym in lower if not sym.isalpha() else re.search(rf"\b{re.escape(sym)}\b", lower))),
        None,
    )
    amount = parse_number(re.sub(r"[a-zA-Z€$£]+\.?", " ", text))
    for pattern, factor in MULTIPLIERS:
        if re.search(rf"(?<=[\d\s]){pattern}\b", lower):
            amount *= factor
            break
    return {"amount": amount, "currency": currency}


def to_date(raw: Any) -> dict:
    """{date: ISO, precision: day|month|year}."""
    if isinstance(raw, (int, float)) and 20000 < raw < 80000:
        # Excel serial date (days since 1899-12-30).
        d = date(1899, 12, 30) + timedelta(days=int(raw))
        return {"date": d.isoformat(), "precision": "day"}
    text = str(raw).strip()
    if m := re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})(T.*)?", text):
        return {"date": f"{m[1]}-{m[2]}-{m[3]}", "precision": "day"}
    if m := re.fullmatch(r"(\d{1,2})[./](\d{1,2})[./](\d{2,4})", text):
        day, month, year = int(m[1]), int(m[2]), int(m[3])
        year += 2000 if year < 100 else 0
        if month > 12 and day <= 12:  # US order
            day, month = month, day
        return {"date": date(year, month, day).isoformat(), "precision": "day"}
    if m := re.fullmatch(r"([A-Za-zä]{3})[a-zä]*\.?\s+(\d{4})", text):
        month = MONTHS.get(m[1].lower())
        if month:
            return {"date": f"{m[2]}-{month:02d}-01", "precision": "month"}
    if m := re.fullmatch(r"(\d{1,2})[./-](\d{4})", text):
        return {"date": f"{m[2]}-{int(m[1]):02d}-01", "precision": "month"}
    if m := re.fullmatch(r"(19|20)\d{2}", text):
        return {"date": f"{text}-01-01", "precision": "year"}
    raise Invalid(f"not a date: {text!r}")


def country(raw: Any, fuzzy: bool = True) -> str:
    text = str(raw).strip().strip(".")
    if text.lower() in COUNTRY_NAMES:
        return COUNTRY_NAMES[text.lower()]
    if len(text) in (2, 3) and text.isalpha():
        hit = pycountry.countries.get(alpha_2=text.upper()) if len(text) == 2 else \
            pycountry.countries.get(alpha_3=text.upper())
        if hit:
            return hit.alpha_2
    try:
        return pycountry.countries.lookup(text).alpha_2
    except LookupError:
        if not fuzzy:
            raise Invalid(f"unknown country: {text!r}") from None
        try:
            return pycountry.countries.search_fuzzy(text)[0].alpha_2
        except LookupError as e:
            raise Invalid(f"unknown country: {text!r}") from e


def location(raw: Any) -> dict:
    parts = [p.strip() for p in re.split(r"[,;/]", str(raw)) if p.strip()]
    if not parts:
        raise Invalid("empty location")
    if len(parts) == 1:
        try:
            return {"city": None, "region": None, "country": country(parts[0], fuzzy=False)}
        except Invalid:
            return {"city": parts[0], "region": None, "country": None}
    try:
        code = country(parts[-1], fuzzy=False)
        middle = parts[1:-1]
        return {"city": parts[0], "region": middle[0] if middle else None,
                "country": code}
    except Invalid:
        return {"city": parts[0], "region": ", ".join(parts[1:]), "country": None}


def enum(raw: Any, options: tuple[str, ...]) -> str:
    text = str(raw).strip()
    for o in options:
        if o.lower() == text.lower():
            return o
    alias = ENUM_ALIASES.get(text.lower())
    if alias in options:
        return alias
    raise Invalid(f"{text!r} isn't one of {', '.join(options)}")


def _one(point: DataPoint, raw: Any) -> Any:
    t = point.type
    if t in ("text", "long_text"):
        return str(raw).strip()
    if t == "int":
        return round(raw if isinstance(raw, (int, float)) else parse_number(str(raw)))
    if t == "int_range":
        return int_range(raw)
    if t == "decimal":
        return float(raw if isinstance(raw, (int, float)) else parse_number(str(raw)))
    if t == "money":
        return money(raw)
    if t == "percent":
        n = float(raw) if isinstance(raw, (int, float)) else parse_number(str(raw))
        # 0.94 as a fraction means 94% unless the text had a % sign.
        if n <= 1 and not str(raw).strip().endswith("%"):
            n *= 100
        if not 0 <= n <= 100:
            raise Invalid(f"{raw!r} isn't between 0 and 100%")
        return round(n, 2)
    if t == "date":
        return to_date(raw)
    if t == "year":
        # Any four-digit year from 1000 to 2100 parses; how likely it is, is
        # for `warnings` to say (old companies are rare, not impossible).
        if isinstance(raw, (int, float)) and not isinstance(raw, bool):
            if raw != int(raw) or not 1000 <= raw <= 2100:
                raise Invalid(f"not a year: {raw!r}")
            return int(raw)
        m = re.search(r"\b(1\d{3}|20\d\d|2100)\b", str(raw))
        if not m:
            raise Invalid(f"not a year: {raw!r}")
        return int(m[1])
    if t == "bool":
        s = str(raw).strip().lower()
        if s in TRUE:
            return True
        if s in FALSE:
            return False
        raise Invalid(f"not yes/no: {raw!r}")
    if t == "enum":
        return enum(raw, point.options)
    if t == "domain":
        s = re.sub(r"^[a-z]+://", "", str(raw).strip().lower())
        s = s.removeprefix("www.").split("/")[0].split("?")[0]
        if not re.fullmatch(r"[a-z0-9.-]+\.[a-z]{2,}", s):
            raise Invalid(f"not a web domain: {raw!r}")
        if host := shared_host(s):
            raise Invalid(f"a page on {host}, not the company's own website")
        return s
    if t == "url":
        s = str(raw).strip()
        if not re.match(r"^https?://", s):
            s = "https://" + s
        if "." not in s:
            raise Invalid(f"not a URL: {raw!r}")
        return s
    if t == "email":
        s = str(raw).strip().lower().removeprefix("mailto:")
        if not re.fullmatch(r"[^@\s]+@[^@\s]+\.[a-z]{2,}", s):
            raise Invalid(f"not an email: {raw!r}")
        return s
    if t == "phone":
        s = re.sub(r"[^\d+]", "", str(raw))
        if len(re.sub(r"\D", "", s)) < 6:
            raise Invalid(f"not a phone number: {raw!r}")
        return s
    if t == "country":
        return country(raw)
    if t == "location":
        return location(raw)
    raise Invalid(f"unsupported type {t}")


def normalize(point: DataPoint, raw: Any) -> Any:
    """Normalised value (a list for multi-value data points). Raises Invalid."""
    if point.many and isinstance(raw, str):
        parts = [p.strip() for p in re.split(r"[;\n|]|,(?!\d)", raw) if p.strip()]
        if point.type == "location":
            # "Munich, DE; Sofia, BG": commas belong to a location.
            parts = [p.strip() for p in re.split(r"[;\n|]", raw) if p.strip()]
        return [_one(point, p) for p in parts]
    value = _one(point, raw)
    return [value] if point.many else value


EARLIEST_LIKELY_YEAR = 1800


def warnings(point: DataPoint, value: Any) -> list[str]:
    """What looks unlikely about a value that parsed: imported, but flagged for
    the reviewer. Never raises; an empty list means nothing to check."""
    out: list[str] = []
    for v in value if isinstance(value, list) else [value]:
        if point.type == "year" and isinstance(v, int):
            if v < EARLIEST_LIKELY_YEAR:
                out.append(f"{v} is unusually early; check it's right")
            elif v > date.today().year:
                out.append(f"{v} is in the future")
    return out


def split_name(full: str) -> tuple[str, str]:
    """'Dr. Anna Maria Muster' → ('Anna Maria', 'Muster'); 'Muster, Anna' too."""
    s = re.sub(r"\b(dr|prof|mr|mrs|ms|herr|frau)\.?\s+", "", full.strip(), flags=re.IGNORECASE)
    if "," in s:
        last, _, first = s.partition(",")
        return first.strip(), last.strip()
    parts = s.split()
    return (" ".join(parts[:-1]), parts[-1]) if len(parts) > 1 else ("", s)
