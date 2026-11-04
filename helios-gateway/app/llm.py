"""The LLM behind table detection and column mapping.

Everything goes through `complete_json`, so switching provider means adding a
`Provider` and selecting it in `provider()`. DeepSeek and self-hosted servers
(vLLM, Ollama, TGI) all speak the OpenAI chat-completions API, which
`OpenAICompatible` covers; most switches are just LLM_BASE_URL and LLM_MODEL.
"""

import json
from functools import lru_cache
from typing import Protocol

import httpx
from pydantic import BaseModel, ValidationError

from app.config import settings


class LLMError(RuntimeError):
    pass


class Provider(Protocol):
    def complete_json(self, system: str, user: str) -> dict: ...


class OpenAICompatible:
    def __init__(self, base_url: str, model: str, api_key: str | None, timeout: float):
        self.model = model
        self.client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers={"Authorization": f"Bearer {api_key}"} if api_key else {},
            timeout=timeout,
        )

    def complete_json(self, system: str, user: str) -> dict:
        response = self.client.post(
            "/chat/completions",
            json={
                "model": self.model,
                "messages": [
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                "temperature": 0,
                "response_format": {"type": "json_object"},
            },
        )
        if response.status_code >= 400:
            raise LLMError(f"LLM request failed ({response.status_code}): "
                           f"{response.text[:300]}")
        content = response.json()["choices"][0]["message"]["content"]
        try:
            return json.loads(content)
        except json.JSONDecodeError as e:
            raise LLMError(f"LLM returned invalid JSON: {content[:300]}") from e


@lru_cache
def provider() -> Provider:
    s = settings()
    base_url, model, key = s.llm
    return OpenAICompatible(base_url, model, key, s.llm_timeout_seconds)


def ask[T: BaseModel](schema: type[T], system: str, user: str, retries: int = 1) -> T:
    """Ask for JSON matching `schema`; on invalid output, retry once with the
    validation error so the model can correct itself."""
    prompt = user
    for attempt in range(retries + 1):
        data = provider().complete_json(system, prompt)
        try:
            return schema.model_validate(data)
        except ValidationError as e:
            if attempt == retries:
                raise LLMError(f"LLM output didn't match the schema: {e}") from e
            prompt = (
                f"{user}\n\nYour previous answer was invalid:\n{e}\n"
                "Answer again with JSON that matches the schema exactly."
            )
    raise AssertionError("unreachable")
