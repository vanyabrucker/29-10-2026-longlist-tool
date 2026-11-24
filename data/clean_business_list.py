"""Clean the Swiss business list (a LinkedIn company export) for Helios.

Usage, from the repo root:

    python3 data/clean_business_list.py "<path to the export>.csv"

Writes two files next to this script:

1. swiss-business-list-over-50.csv: the firms with more than 50 employees,
   rows unchanged.
2. swiss-business-list-over-50-clean.csv: the same firms, cleaned:
   - names title-cased, with legal forms (AG, SA, GmbH), acronyms (ETH, FC,
     SBB) and small words (de, und, of) written the usual way;
   - locality, region and country joined into one `location` column, e.g.
     "Zurich, Zurich, Switzerland" (empty parts left out);
   - a founded year of 0 left empty.

Both files are UTF-8 with a byte-order mark, so Excel shows the accents
right. Only the standard library is used.
"""

from __future__ import annotations

import argparse
import csv
import re
import sys
from pathlib import Path

OUT_DIR = Path(__file__).resolve().parent
FILTERED = "swiss-business-list-over-50.csv"
CLEANED = "swiss-business-list-over-50-clean.csv"
MIN_EMPLOYEES = 50  # keep firms with more employees than this

REQUIRED = {
    "country", "founded", "id", "industry", "linkedin_url",
    "locality", "name", "region", "size", "website",
}  # fmt: skip
LOCATION_PARTS = ("locality", "region", "country")

# Written this way wherever they appear.
FIXED = {
    "ag": "AG",
    "sa": "SA",
    "s.a": "S.A",
    "gmbh": "GmbH",
    "kg": "KG",
    "kgaa": "KGaA",
    "ltd": "Ltd",
    "hes-so": "HES-SO",
}
# Acronyms that contain a vowel, as found in the names. Words without a vowel
# (FC, SBB, ZH, KPMG) are uppercased by rule, except those in NOT_ACRONYMS.
ACRONYMS = {
    "abb", "ai", "axa", "bdo", "bni", "cern", "chuv", "csem", "edv", "ehc",
    "ekz", "emea", "ems", "epfl", "erp", "eth", "eu", "evz", "ewl", "ewz",
    "fifa", "hec", "heg", "hes", "iata", "ibc", "icrc", "ict", "iec", "imd",
    "iot", "iso", "it", "iucn", "iv", "ivf", "iwb", "kmu", "mba", "mdpi",
    "oecd", "ofac", "psi", "ruag", "sdis", "seco", "sia", "sos", "tui", "ubs",
    "uefa", "uk", "unicef", "usa", "uzh", "vip", "zhaw",
}  # fmt: skip
NOT_ACRONYMS = {"dr", "jr", "mbh", "mr", "mrs", "schw", "st"}
# Lowercase unless they start the name or a phrase (after "-", "|", "(" ...).
SMALL_WORDS = {
    # English
    "a", "an", "and", "at", "by", "for", "in", "of", "on", "or", "the", "to",
    # German
    "am", "auf", "bei", "das", "der", "die", "für", "im", "mit", "und", "vom",
    "von", "zu", "zum", "zur",
    # French ("la", "le" and "les" stay capitalised: often part of a name)
    "à", "au", "aux", "de", "des", "du", "en", "et", "pour", "sur",
    # Italian
    "di", "del", "della", "e", "per",
}  # fmt: skip
PHRASE_BREAKS = {"-", "–", "—", "|", "/", ":"}
SEGMENT_BREAKS = {"-", "–", "—", "|"}
ELISIONS = {"d", "l"}  # d'Orientation, L'Occitane
# "la", "le" and "les" are articles after these ("Hôtel de la Paix"), unless
# a hyphenated place name follows ("Ville de La Chaux-de-Fonds").
PREPOSITIONS = {"à", "de", "et", "par", "pour", "sur"}
ARTICLES = {"la", "le", "les"}

EDGES = re.compile(r"^(\W*)(.*?)(\W*)$", re.DOTALL)
CONSONANTS_ONLY = re.compile(r"[b-df-hj-np-tv-xz]{2,6}")
INITIALS = re.compile(r"\w(?:\.\w)+")
ELISION = re.compile(r"(\w)(['’])(.+)", re.DOTALL)
WORD_PARTS = re.compile(r"[-/&+'’]")
SIZE_BAND = re.compile(r"(\d+)(?:-(\d+)|\+)")


def title_case(text: str) -> str:
    """Title-case a lowercase company or place name.

    >>> title_case("hockey club davos ag")
    'Hockey Club Davos AG'
    >>> title_case("dofival sàrl")
    'Dofival Sàrl'
    >>> title_case("banque cantonale de genève")
    'Banque Cantonale de Genève'
    >>> title_case("fc basel 1893 ag")
    'FC Basel 1893 AG'
    >>> title_case("eth zürich - the learning sciences")
    'ETH Zürich - The Learning Sciences'
    >>> title_case("unsere champions (schweiz) ag, zug")
    'Unsere Champions (Schweiz) AG, Zug'
    >>> title_case("office d'orientation et de carrière")
    "Office d'Orientation et de Carrière"
    >>> title_case("l'osteria st.gallen s.a.")
    "L'Osteria St.Gallen S.A."
    >>> title_case("la chaux-de-fonds")
    'La Chaux-de-Fonds'
    >>> title_case("hans a. vogel ag")
    'Hans A. Vogel AG'
    >>> title_case("the impactful women's network")
    "The Impactful Women's Network"
    >>> title_case("kurmann consulting/e-commerce 4.0")
    'Kurmann Consulting/E-Commerce 4.0'
    >>> title_case("swiss game developers association (sgda)")
    'Swiss Game Developers Association (SGDA)'
    >>> title_case("fim (federation internationale de motocyclisme)")
    'FIM (Federation Internationale de Motocyclisme)'
    >>> title_case("stiftung behindertenbetriebe uri - sbu")
    'Stiftung Behindertenbetriebe Uri - SBU'
    >>> title_case("hôtel de la paix, ville de la chaux-de-fonds")
    'Hôtel de la Paix, Ville de La Chaux-de-Fonds'
    >>> title_case("swiss m&a experts - now part of landis+gyr")
    'Swiss M&A Experts - Now Part of Landis+Gyr'
    >>> title_case("etude er&a")
    'Etude ER&A'
    >>> title_case("travail social de la hes-so")
    'Travail Social de la HES-SO'
    """
    tokens = [EDGES.match(token).groups() for token in text.split()]
    abbreviations = _abbreviations(tokens)
    words = []
    start = True
    previous = ""
    for i, (lead, core, trail) in enumerate(tokens):
        lower = core.lower()
        if i in abbreviations or (len(core) == 1 and trail.startswith(".")):
            core = core.upper()  # "(SGDA)", or an initial: "A. Vogel"
        elif (
            not start
            and not lead
            and previous in PREPOSITIONS
            and lower in ARTICLES
            and not _place_name(tokens, i + 1)
        ):
            core = lower
        elif core:
            core = _case_word(core, start or "(" in lead or '"' in lead)
        words.append(lead + core + trail)
        start = (not core and lead in PHRASE_BREAKS) or trail.endswith(":")
        previous = "" if trail else lower
    return " ".join(words)


def _place_name(tokens: list[tuple[str, str, str]], i: int) -> bool:
    """Whether word `i` is hyphenated like a place name ("chaux-de-fonds")."""
    if i >= len(tokens):
        return False
    core = tokens[i][1]
    return "-" in core and core.lower() not in FIXED


def _abbreviations(tokens: list[tuple[str, str, str]]) -> set[int]:
    """Indexes of words that abbreviate the name's other words.

    Only a word alone in brackets ("... association (sgda)"), alone between
    dashes ("... uri - sbu") or right before brackets ("fim (federation ...)"),
    3 to 6 letters long, whose letters are initials of the other words in order.
    """
    found = set()
    for i, (lead, core, trail) in enumerate(tokens):
        if not (3 <= len(core) <= 6 and core.isalpha()):
            continue
        in_brackets = lead == "(" and trail.startswith(")")
        alone = len(tokens) > 1 and all(
            j < 0
            or j >= len(tokens)
            or (not tokens[j][1] and tokens[j][0] in SEGMENT_BREAKS)
            for j in (i - 1, i + 1)
        )
        before_brackets = (
            not lead
            and not trail
            and i + 1 < len(tokens)
            and tokens[i + 1][0].startswith("(")
        )
        if not (in_brackets or alone or before_brackets):
            continue
        initials = iter(
            part[0].lower()
            for j, (_, other, _) in enumerate(tokens)
            if j != i
            for part in WORD_PARTS.split(other)
            if part
        )
        if all(letter in initials for letter in core.lower()):
            found.add(i)
    return found


def _case_word(word: str, start: bool) -> str:
    lower = word.lower()
    if lower in FIXED:
        return FIXED[lower]
    for joiner in "/&+":
        if joiner in word:
            if all(len(part) <= 2 for part in word.split(joiner)):
                return word.upper()  # "ER&A", "B+F"
            return joiner.join(
                _case_word(p, True) if p else p for p in word.split(joiner)
            )
    if "-" in word:
        parts = word.split("-")
        return "-".join(
            _case_word(p, start and i == 0) if p else p for i, p in enumerate(parts)
        )
    if INITIALS.fullmatch(word):
        return word.upper()
    if lower.startswith("st.") and len(word) > 3:
        return "St." + _case_word(word[3:], True)
    elision = ELISION.fullmatch(word)
    if elision and elision.group(1).lower() in ELISIONS:
        letter, apostrophe, rest = elision.groups()
        letter = letter.upper() if start else letter.lower()
        return letter + apostrophe + _case_word(rest, True)
    if not start and lower in SMALL_WORDS:
        return lower
    if lower in ACRONYMS or (
        CONSONANTS_ONLY.fullmatch(lower) and lower not in NOT_ACRONYMS
    ):
        return word.upper()
    return word[:1].upper() + word[1:]


def more_than(band: str, limit: int) -> bool:
    """Whether a LinkedIn size band ("51-200", "10001+") lies above `limit`.

    >>> more_than("51-200", 50), more_than("11-50", 50), more_than("10001+", 50)
    (True, False, True)
    """
    match = SIZE_BAND.fullmatch(band.strip())
    if not match:
        raise ValueError(f"Unknown size band {band!r}")
    low, high = int(match.group(1)), match.group(2)
    if low > limit:
        return True
    if high is not None and int(high) <= limit:
        return False
    raise ValueError(f"Size band {band!r} has firms on both sides of {limit}")


def clean_header(header: list[str]) -> list[str]:
    """The cleaned file's columns: `location` replaces the three it joins."""
    fields = []
    for field in header:
        if field == "locality":
            fields.append("location")
        elif field not in LOCATION_PARTS:
            fields.append(field)
    return fields


def clean(row: dict[str, str]) -> dict[str, str]:
    out = {k: v for k, v in row.items() if k not in LOCATION_PARTS}
    out["name"] = title_case(row["name"])
    out["location"] = ", ".join(
        title_case(row[part]) for part in LOCATION_PARTS if row[part].strip()
    )
    founded = row["founded"].strip()
    if founded and not founded.isdigit():
        raise ValueError(f"{row['id']}: founded {founded!r} isn't a year")
    out["founded"] = "" if founded and int(founded) == 0 else founded
    return out


def write(path: Path, fields: list[str], rows: list[dict[str, str]]) -> None:
    with path.open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.DictWriter(
            f, fieldnames=fields, quoting=csv.QUOTE_ALL, lineterminator="\n"
        )
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("source", type=Path, help="the LinkedIn export (CSV)")
    source = parser.parse_args().source

    with source.open(newline="", encoding="utf-8-sig") as f:
        reader = csv.DictReader(f)
        header = list(reader.fieldnames or [])
        missing = REQUIRED - set(header)
        if missing:
            sys.exit(f"{source} lacks the column(s): {', '.join(sorted(missing))}")
        rows = list(reader)

    big = [row for row in rows if more_than(row["size"], MIN_EMPLOYEES)]
    write(OUT_DIR / FILTERED, header, big)

    cleaned = [clean(row) for row in big]
    write(OUT_DIR / CLEANED, clean_header(header), cleaned)

    emptied = sum(1 for a, b in zip(big, cleaned) if a["founded"] != b["founded"])
    print(f"Read {len(rows):,} firms; {len(big):,} have more than {MIN_EMPLOYEES}.")
    print(f"Wrote {OUT_DIR / FILTERED}")
    print(f"Wrote {OUT_DIR / CLEANED} ({emptied:,} founded years of 0 emptied)")


if __name__ == "__main__":
    main()
