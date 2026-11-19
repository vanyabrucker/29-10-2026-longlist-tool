"""Region presets for search filters, and the approximate currency rates
revenue range filters use.

There is no FX in Helios yet: revenue is stored and shown in the currency it
was reported in. A revenue *filter* still has to compare a CHF company with a
EUR range, so it converts with the fixed, rounded rates below. They are only
for deciding whether a company falls inside a range, never shown or stored.
A currency missing here can't be compared, so it counts as missing revenue.
"""

from typing import Literal

Region = Literal["dach", "benelux", "nordics", "eu", "europe", "uk_ireland",
                 "north_america", "asia_pacific"]

EU = ("AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU",
      "IE", "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES",
      "SE")

REGIONS: dict[str, tuple[str, ...]] = {
    "dach": ("DE", "AT", "CH"),
    "benelux": ("BE", "NL", "LU"),
    "nordics": ("DK", "FI", "IS", "NO", "SE"),
    "eu": EU,
    "europe": (*EU, "CH", "NO", "IS", "LI", "GB", "AL", "BA", "ME", "MK", "RS", "MD",
               "UA", "AD", "MC", "SM"),
    "uk_ireland": ("GB", "IE"),
    "north_america": ("US", "CA"),
    "asia_pacific": ("CN", "JP", "KR", "IN", "SG", "HK", "TW", "AU", "NZ", "MY", "TH",
                     "ID", "VN", "PH"),
}

# EUR per unit, rounded, as of November 2026.
APPROX_RATES_AS_OF = "2026-11"
APPROX_EUR_PER_UNIT: dict[str, float] = {
    "EUR": 1.0, "CHF": 1.07, "USD": 0.92, "GBP": 1.17, "SEK": 0.087, "NOK": 0.085,
    "DKK": 0.134, "PLN": 0.23, "CZK": 0.040, "HUF": 0.0025, "JPY": 0.0061,
    "CNY": 0.13, "CAD": 0.67, "AUD": 0.60,
}
Currency = Literal["EUR", "CHF", "USD", "GBP", "SEK", "NOK", "DKK", "PLN", "CZK",
                   "HUF", "JPY", "CNY", "CAD", "AUD"]


def countries(codes: list[str] | tuple[str, ...] = (),
              regions: list[str] | tuple[str, ...] = ()) -> tuple[str, ...]:
    """ISO codes for a country list plus region presets (unknown regions are
    the caller's validation problem and are ignored here)."""
    out = {c.upper() for c in codes}
    for r in regions:
        out.update(REGIONS.get(r, ()))
    return tuple(sorted(out))
