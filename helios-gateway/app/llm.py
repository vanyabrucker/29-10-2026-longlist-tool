"""The LLM behind table detection, column mapping, and the agent's chat loop.

Imports use `complete_json` via `provider()`. The agent uses `chat_provider()`
for streaming tool-calling chat. Both speak the OpenAI chat-completions API;
switching provider is settings (base URL, model, key, auth style).
"""

from __future__ import annotations

import json
import time
from collections.abc import Iterator
from dataclasses import dataclass, field
from functools import lru_cache
from typing import Any, Literal, Protocol

import httpx
from pydantic import BaseModel, ValidationError

from app.config import estimate_cost_usd, settings


class LLMError(RuntimeError):
    """`status` is the provider's HTTP status, when it answered with one."""

    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status

    @property
    def user_message(self) -> str:
        """What the chat shows (the raw provider text stays in the log)."""
        if self.status == 429:
            return ("The language model is over its rate limit right now. "
                    "Wait a minute, then send a message to carry on.")
        if self.status is not None and self.status >= 500:
            return ("The language model had a server error. "
                    "Send a message to try again.")
        return "The language model request failed. Send a message to try again."


# Rate limits and provider hiccups are retried, before any output streamed.
# Azure meters tokens per minute, so a limit can take most of a minute to
# clear: the provider's own reset time is honoured, up to a minute per wait.
RETRY_STATUSES = (429, 500, 502, 503, 504)
RETRY_DELAYS = (2.0, 5.0, 10.0, 20.0, 30.0)
MAX_RETRY_AFTER = 60.0
_RESET_HEADERS = ("retry-after", "x-ratelimit-reset-tokens", "x-ratelimit-reset-requests")


def retry_delay(response: httpx.Response, attempt: int) -> float:
    """The provider's reset time (seconds) when it sends one, else the backoff."""
    after = 0.0
    if ms := response.headers.get("retry-after-ms"):
        try:
            after = float(ms) / 1000
        except ValueError:
            pass
    for name in _RESET_HEADERS:
        try:
            after = max(after, float(response.headers.get(name, "")))
        except ValueError:
            continue
    return min(max(after, RETRY_DELAYS[attempt]), MAX_RETRY_AFTER)


def _failed(response: httpx.Response) -> LLMError:
    return LLMError(f"LLM request failed ({response.status_code}): "
                    f"{response.text[:300]}", response.status_code)


class Provider(Protocol):
    def complete_json(self, system: str, user: str) -> dict: ...


AuthStyle = Literal["bearer", "api-key"]


def _headers(api_key: str | None, auth: AuthStyle) -> dict[str, str]:
    if not api_key:
        return {}
    if auth == "api-key":
        return {"api-key": api_key}
    return {"Authorization": f"Bearer {api_key}"}


class OpenAICompatible:
    """JSON completions for imports (non-streaming)."""

    def __init__(
        self, base_url: str, model: str, api_key: str | None, timeout: float,
        auth: AuthStyle = "bearer",
    ):
        self.model = model
        self.client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers=_headers(api_key, auth),
            timeout=timeout,
        )

    def complete_json(self, system: str, user: str) -> dict:
        for attempt in range(len(RETRY_DELAYS) + 1):
            response = self._post_json(system, user)
            if (response.status_code not in RETRY_STATUSES
                    or attempt == len(RETRY_DELAYS)):
                break
            time.sleep(retry_delay(response, attempt))
        if response.status_code >= 400:
            raise _failed(response)
        content = response.json()["choices"][0]["message"]["content"]
        try:
            return json.loads(content)
        except json.JSONDecodeError as e:
            raise LLMError(f"LLM returned invalid JSON: {content[:300]}") from e

    def _post_json(self, system: str, user: str) -> httpx.Response:
        return self.client.post(
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


# ── Streaming chat (agent) ─────────────────────────────────────────────────


ChatEventKind = Literal["text_delta", "tool_call", "done", "usage"]


@dataclass
class ChatEvent:
    kind: ChatEventKind
    text: str | None = None
    tool_call_id: str | None = None
    tool_name: str | None = None
    tool_arguments: str | None = None
    finish_reason: str | None = None
    prompt_tokens: int | None = None
    completion_tokens: int | None = None
    total_tokens: int | None = None
    latency_ms: int | None = None


@dataclass
class ChatUsage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    total_tokens: int = 0
    latency_ms: int = 0
    cost_usd: float | None = None
    provider: str = ""
    model: str = ""


@dataclass
class ChatResult:
    """One completed model turn (after the stream ends)."""

    text: str = ""
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    finish_reason: str | None = None
    usage: ChatUsage = field(default_factory=ChatUsage)
    # Stopped by the user mid-stream: text is what arrived until then.
    interrupted: bool = False


class ChatProvider(Protocol):
    provider_name: str
    model: str

    def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> Iterator[ChatEvent]: ...


class OpenAIChat:
    """Streaming chat completions with tool calls (OpenAI-compatible)."""

    def __init__(
        self, *, provider_name: str, base_url: str, model: str,
        api_key: str | None, timeout: float, auth: AuthStyle = "bearer",
    ):
        self.provider_name = provider_name
        self.model = model
        self.client = httpx.Client(
            base_url=base_url.rstrip("/"),
            headers=_headers(api_key, auth),
            timeout=timeout,
        )

    def stream(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> Iterator[ChatEvent]:
        body: dict[str, Any] = {
            "model": self.model,
            "messages": messages,
            "stream": True,
            "stream_options": {"include_usage": True},
        }
        if tools:
            body["tools"] = tools
        started = time.monotonic()
        tool_acc: dict[int, dict[str, str]] = {}
        finish: str | None = None
        usage_event: ChatEvent | None = None
        try:
            response = self._open(body)
            try:
                for line in response.iter_lines():
                    if not line:
                        continue
                    if line.startswith("data:"):
                        line = line[5:].strip()
                    if line == "[DONE]":
                        break
                    try:
                        chunk = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if chunk.get("usage"):
                        u = chunk["usage"]
                        usage_event = ChatEvent(
                            kind="usage",
                            prompt_tokens=u.get("prompt_tokens") or 0,
                            completion_tokens=u.get("completion_tokens") or 0,
                            total_tokens=u.get("total_tokens") or 0,
                        )
                    for choice in chunk.get("choices") or []:
                        delta = choice.get("delta") or {}
                        if delta.get("content"):
                            yield ChatEvent(kind="text_delta", text=delta["content"])
                        for tc in delta.get("tool_calls") or []:
                            idx = tc.get("index", 0)
                            slot = tool_acc.setdefault(
                                idx, {"id": "", "name": "", "arguments": ""})
                            if tc.get("id"):
                                slot["id"] = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                slot["name"] = fn["name"]
                            if fn.get("arguments"):
                                slot["arguments"] += fn["arguments"]
                        if choice.get("finish_reason"):
                            finish = choice["finish_reason"]
            finally:
                response.close()
        except httpx.HTTPError as e:
            raise LLMError(f"LLM stream failed: {e}") from e

        for idx in sorted(tool_acc):
            slot = tool_acc[idx]
            yield ChatEvent(
                kind="tool_call",
                tool_call_id=slot["id"] or f"call_{idx}",
                tool_name=slot["name"],
                tool_arguments=slot["arguments"] or "{}",
            )
        latency_ms = int((time.monotonic() - started) * 1000)
        if usage_event is None:
            usage_event = ChatEvent(kind="usage", prompt_tokens=0,
                                    completion_tokens=0, total_tokens=0)
        yield usage_event
        yield ChatEvent(kind="done", finish_reason=finish or "stop",
                        latency_ms=latency_ms)

    def _open(self, body: dict[str, Any]) -> httpx.Response:
        """Open the stream; rate limits and server errors are retried with
        backoff (nothing has streamed yet, so a retry is invisible)."""
        for attempt in range(len(RETRY_DELAYS) + 1):
            request = self.client.build_request("POST", "/chat/completions", json=body)
            response = self.client.send(request, stream=True)
            if response.status_code < 400:
                return response
            response.read()
            response.close()
            if (response.status_code not in RETRY_STATUSES
                    or attempt == len(RETRY_DELAYS)):
                raise _failed(response)
            time.sleep(retry_delay(response, attempt))
        raise AssertionError("unreachable")

    def complete(
        self,
        messages: list[dict[str, Any]],
        tools: list[dict[str, Any]] | None = None,
    ) -> ChatResult:
        """Run a full stream and fold it into one ChatResult."""
        text_parts: list[str] = []
        tool_calls: list[dict[str, Any]] = []
        finish: str | None = None
        usage = ChatUsage(provider=self.provider_name, model=self.model)
        for event in self.stream(messages, tools):
            if event.kind == "text_delta" and event.text:
                text_parts.append(event.text)
            elif event.kind == "tool_call":
                tool_calls.append({
                    "id": event.tool_call_id,
                    "type": "function",
                    "function": {
                        "name": event.tool_name,
                        "arguments": event.tool_arguments or "{}",
                    },
                })
            elif event.kind == "usage":
                usage.prompt_tokens = event.prompt_tokens or 0
                usage.completion_tokens = event.completion_tokens or 0
                usage.total_tokens = event.total_tokens or (
                    usage.prompt_tokens + usage.completion_tokens)
                usage.cost_usd = estimate_cost_usd(
                    self.model, usage.prompt_tokens, usage.completion_tokens)
            elif event.kind == "done":
                finish = event.finish_reason
                usage.latency_ms = event.latency_ms or 0
        return ChatResult(text="".join(text_parts), tool_calls=tool_calls,
                          finish_reason=finish, usage=usage)


@lru_cache
def provider() -> Provider:
    s = settings()
    base_url, model, key, auth = s.llm
    return OpenAICompatible(base_url, model, key, s.llm_timeout_seconds, auth)


@lru_cache
def chat_provider() -> ChatProvider:
    s = settings()
    base_url, model, key, auth = s.agent_llm
    return OpenAIChat(
        provider_name=s.agent_llm_provider,
        base_url=base_url,
        model=model,
        api_key=key,
        timeout=s.agent_llm_timeout_seconds,
        auth=auth,
    )


def chat_provider_for(provider_name: str, model: str | None = None) -> ChatProvider:
    """A chat provider other than the configured one (evals: the model under
    test, the judge), by built-in provider name ("deepseek", "azure_foundry")
    with its own keys from settings; `model` overrides its default model or
    deployment."""
    s = settings()
    base_url, model_name, key, auth = s._resolve(provider_name, None, model, None)
    return OpenAIChat(provider_name=provider_name, base_url=base_url, model=model_name,
                      api_key=key, timeout=s.agent_llm_timeout_seconds, auth=auth)


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
