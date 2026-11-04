"""Quality score per value: source confidence × freshness, 0–100.

The value shown for a data point is the live observation with the best score;
ties go to the newer version. A value without an as-of date counts as half
fresh, so it ranks below a dated value from an equally trusted source.
"""

from datetime import date

from app.catalogue import CATALOGUE

UNDATED_FRESHNESS = 0.5


def freshness(field: str, as_of: date | None, today: date | None = None) -> float:
    point = CATALOGUE.get(field)
    half_life = point.half_life_days if point else 365
    if half_life is None:
        return 1.0
    if as_of is None:
        return UNDATED_FRESHNESS
    days = max(0, ((today or date.today()) - as_of).days)
    return 0.5 ** (days / half_life)


def score(confidence: float, field: str, as_of: date | None) -> float:
    return round(100 * confidence * freshness(field, as_of), 1)


def level(value: float | None) -> str:
    """Same thresholds as the app's data-quality dots."""
    if value is None:
        return "unknown"
    return "high" if value >= 70 else "medium" if value >= 45 else "low"
