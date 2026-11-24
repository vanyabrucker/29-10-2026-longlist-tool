"""Transformations a mapped column can carry, applied to the raw cell before
normalizing: treat values as empty, combine with other columns, scale money
or numbers. A fixed menu; anything else is rejected when the mapping is saved."""

from typing import Annotated, Any, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    TypeAdapter,
    field_validator,
)

from app.ingest.normalize import Invalid, is_empty, money

Short = Annotated[str, StringConstraints(max_length=60)]


class EmptyValues(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["empty_values"]
    values: list[Short] = Field(min_length=1)


class Combine(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["combine"]
    columns: list[str] = Field(min_length=1, max_length=5)
    separator: str = Field(default=", ", max_length=5)

    @field_validator("columns")
    @classmethod
    def _distinct_and_named(cls, columns: list[str]) -> list[str]:
        if any(not c.strip() for c in columns):
            raise ValueError("combine columns can't be blank")
        if len(set(columns)) != len(columns):
            raise ValueError("combine columns must be distinct")
        return columns


class Scale(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["scale"]
    factor: Literal[1000, 1000000]


Transform = Annotated[EmptyValues | Combine | Scale, Field(discriminator="kind")]

_ADAPTER: TypeAdapter[list[Transform]] = TypeAdapter(list[Transform])


def parse(raw: list[dict]) -> list[Transform]:
    """Validate transforms as stored (dicts). Raises pydantic's ValidationError."""
    return _ADAPTER.validate_python(raw)


def apply(transforms: list[Transform], cells: list[Any], index: int,
          letters: dict[str, int]) -> Any:
    """The cell at `index` after the transforms, in order; None when emptied."""
    value = cells[index]
    for t in transforms:
        value = _step(t, value, cells, letters)
    return value


def check(transforms: list[Transform], letters: dict[str, int], own: str) -> None:
    """Reject combines of a column that isn't in the table, or of the column itself."""
    for t in transforms:
        if isinstance(t, Combine):
            for letter in t.columns:
                if letter == own:
                    raise ValueError(f"Column {own} can't be combined with itself.")
                if letter not in letters:
                    raise ValueError(f"Column {letter} isn't in this table.")


def _step(t: Transform, value: Any, cells: list[Any], letters: dict[str, int]) -> Any:
    if isinstance(t, EmptyValues):
        if value is not None and str(value).strip().casefold() in {
                v.strip().casefold() for v in t.values}:
            return None
        return value
    if isinstance(t, Combine):
        parts = [value] + [cells[letters[letter]] for letter in t.columns]
        kept = [str(p) for p in parts if not is_empty(p)]
        return t.separator.join(kept) or None
    return _scale(t.factor, value)


def _scale(factor: int, value: Any) -> Any:
    if is_empty(value):
        return value
    if isinstance(value, (int, float)):
        return value * factor
    try:
        parsed = money(value)
    except Invalid:
        # Unparseable text stays as it is; normalize reports it.
        return value
    amount = parsed["amount"] * factor
    shown = int(amount) if float(amount).is_integer() else amount
    if parsed["currency"]:
        return f"{parsed['currency']} {shown}"
    return shown
