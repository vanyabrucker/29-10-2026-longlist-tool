"""Inline citations in agent-written text (a rationale, a chat message).

Syntax: ``[[source | url | evidence]]``. The frontend shows each as a small
numbered chip; hovering it shows the source and the evidence. Rules:

- ``source`` is a short name: a person ("Anna Keller"), a data provider
  ("S&P Capital IQ", "Orbis") or, for a web page, anything (the UI shows
  "Web research" and the page's host instead).
- ``url`` is the web page, or empty for internal data. Only http(s).
- ``evidence`` is what the source says, with its period ("Revenue CHF 120m,
  FY2024"). Split on the first two pipes, so it may hold anything but ``]]``.

The text stays plain strings everywhere (events, list versions, edits); only
the tools check the syntax, so a malformed marker is fixed by the model
rather than shown to the user as raw brackets.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

MARKER = re.compile(r"\[\[(.*?)\]\]", re.DOTALL)
MAX_SOURCE = 80
MAX_EVIDENCE = 500


@dataclass(frozen=True)
class Citation:
    source: str
    url: str
    evidence: str


def parse(marker_body: str) -> Citation:
    """One marker's inside; raises ValueError saying what to fix."""
    parts = [p.strip() for p in marker_body.split("|", 2)]
    if len(parts) != 3:
        raise ValueError(
            "a citation is [[source | url | evidence]]: three parts split by '|' "
            "(leave the url empty for internal data)")
    source, url, evidence = parts
    if not source or len(source) > MAX_SOURCE:
        raise ValueError(f"citation source must be 1–{MAX_SOURCE} characters "
                         "(a person, 'S&P Capital IQ', 'Orbis' or a web page's name)")
    if url and not re.match(r"^https?://\S+$", url):
        raise ValueError(f"citation url '{url}' must be an http(s) link, or empty "
                         "for internal data")
    if not evidence or len(evidence) > MAX_EVIDENCE:
        raise ValueError(f"citation evidence must be 1–{MAX_EVIDENCE} characters: "
                         "what the source says, with its period")
    return Citation(source, url, evidence)


def check(text: str) -> str:
    """Return the text if every citation in it is well formed, else raise
    ValueError. Stray '[[' or ']]' outside a marker are errors too."""
    for m in MARKER.finditer(text):
        parse(m.group(1))
    if "[[" in MARKER.sub("", text) or "]]" in MARKER.sub("", text):
        raise ValueError("unclosed citation: write [[source | url | evidence]]")
    return text

