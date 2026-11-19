"""The agent's setup (system prompt, skills, tools, model), defined in the
repo and versioned in the database.

The prompt lives in `prompt.md` and the skills in `skills/*.md`. A chat
records the config version it started with, and that row holds a full copy
of the prompt and the skill texts, so a chat keeps behaving the same when
the files change later. Editing the files makes a new version on the next
new chat: no migration needed.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.orm import Session

from app.agent.tools import ARGS
from app.config import settings
from app.models import AgentConfig

HERE = Path(__file__).resolve().parent
PROMPT_FILE = HERE / "prompt.md"
SKILLS_DIR = HERE / "skills"
SKILLS = ("build_list", "refine_list", "after_import")
NAME = "helios"
# Serialises creating a new version (two first chats after an edit).
CONFIG_LOCK = 7_331_002


def spec() -> dict[str, Any]:
    s = settings()
    _, model, _, _ = s.agent_llm
    return {
        "name": NAME,
        "model": f"{s.agent_llm_provider}:{model}",
        "system_prompt": PROMPT_FILE.read_text().strip(),
        "tools": list(ARGS),
        "skills": [{"name": n, "text": (SKILLS_DIR / f"{n}.md").read_text().strip()}
                   for n in SKILLS],
    }


def content_hash(s: dict[str, Any]) -> str:
    return hashlib.sha256(json.dumps(s, sort_keys=True).encode()).hexdigest()


def current_version(session: Session) -> int:
    """The version matching the files and settings now, created if new."""
    s = spec()
    digest = content_hash(s)

    def existing() -> int | None:
        return session.scalar(select(AgentConfig.version)
                              .where(AgentConfig.content_hash == digest)
                              .order_by(AgentConfig.version.desc()).limit(1))

    found = existing()
    if found is not None:
        return found
    session.execute(text("SELECT pg_advisory_xact_lock(:id)"), {"id": CONFIG_LOCK})
    found = existing()
    if found is not None:
        return found
    version = (session.scalar(select(func.max(AgentConfig.version))) or 0) + 1
    session.add(AgentConfig(version=version, content_hash=digest, **s))
    session.flush()
    return version


def skills_text(skills: list) -> str:
    """The skills of a stored config. Versions made before skills were
    copied into the row hold only names; those read the files."""
    parts = []
    for skill in skills or []:
        if isinstance(skill, dict):
            parts.append(skill.get("text") or "")
        else:
            path = SKILLS_DIR / f"{skill}.md"
            if path.is_file():
                parts.append(path.read_text().strip())
    return "\n\n".join(p for p in parts if p)
