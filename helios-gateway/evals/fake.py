"""Scripted stand-ins for the agent model and the judge (no keys, no cost).

`FakeAgent` walks the build-list path from the last message alone, so any
number of chats can share it: ask a scoping question → search our data →
ask for web approval → search the web if approved → create a list → sum
up. A follow-up message after that gets a one-line answer. A chat that
starts on a list gets a naive filter instead (read it, drop every row whose
HQ doesn't say Switzerland, unknown ones too). Used by the smoke
test and `-T agent_model=fake`, to try the eval plumbing for free.
"""

from __future__ import annotations

import json
import re
import uuid
from typing import Any

from app.llm import ChatResult, ChatUsage


def _usage(name: str) -> ChatUsage:
    return ChatUsage(provider="fake", model=name, prompt_tokens=100,
                     completion_tokens=20, total_tokens=120, latency_ms=5, cost_usd=0.0)


def _call(name: str, arguments: dict[str, Any]) -> dict[str, Any]:
    return {"id": f"call_{uuid.uuid4().hex[:12]}", "type": "function",
            "function": {"name": name, "arguments": json.dumps(arguments)}}


def _last_tool(messages: list[dict]) -> tuple[str | None, str]:
    """The tool whose result is the last message, and that result."""
    if not messages or messages[-1].get("role") != "tool":
        return None, ""
    call_id = messages[-1].get("tool_call_id")
    for m in reversed(messages):
        for c in m.get("tool_calls") or []:
            if c["id"] == call_id:
                return c["function"]["name"], messages[-1].get("content") or ""
    return None, ""


class FakeAgent:
    provider_name = "fake"
    model = "fake-agent"

    def complete(self, messages: list[dict], tools=None) -> ChatResult:
        name, content = _last_tool(messages)
        target = "the target"
        first = next((m["content"] for m in messages if m.get("role") == "user"), "")
        if first.lower().startswith("name:"):
            target = first[5:].split("\n")[0].strip() or target
        on_list = re.search(r"\(list_id ([0-9a-f-]{36})\)", messages[0]["content"])
        if name is None and on_list and not any(m.get("tool_calls") for m in messages):
            return self._step("", "read_list", {"list_id": on_list.group(1)})
        scoring = "score every" in first.lower()
        if name == "read_list" and scoring:
            # A careless scorer: 0 where revenue or ticket is missing, the
            # same vague line everywhere (what the scoring scenario catches).
            data = json.loads(content)
            ops = []
            for r in data.get("rows") or []:
                v = r["values"]
                known = v.get("revenue") or v.get("ticket_size_min")
                ops += [{"op": "set_cell", "row_id": r["row_id"], "column": "relevance_score",
                         "value": 50 if known else 0},
                        {"op": "set_cell", "row_id": r["row_id"],
                         "column": "relevance_explanation", "value": "Good fit overall."}]
            return self._step("", "update_list", {"list_id": data["list_id"],
                                                  "message": "Scored", "ops": ops})
        if name == "read_list":
            # A naive filter: keeps only rows whose HQ says Switzerland, so
            # rows with an unknown HQ silently go (what the scenario catches).
            rows = json.loads(content).get("rows") or []
            gone = [r["row_id"] for r in rows
                    if (r["values"].get("hq") or {}).get("country") != "CH"]
            return self._step("", "update_list", {
                "list_id": json.loads(content)["list_id"], "message": "Filtered",
                "ops": [{"op": "remove_row", "row_id": i} for i in gone]})
        if name == "update_list":
            return self._reply("I filtered the list.")
        if name is None:
            if any(m.get("tool_calls") for m in messages):
                return self._reply("Noted.")
            return self._step("Here is how I read the mandate.", "ask_user", {
                "question": "Build longlists on this basis?", "options": ["Yes", "No"]})
        if name == "ask_user":
            return self._step("", "corpus_search", {"query": target, "limit": 5})
        if name == "corpus_search":
            return self._step("I'd like to check the web too.", "request_web_research", {
                "scope": "turn", "reason": "Search the web for more buyers?"})
        if name == "request_web_research":
            if "approved" in content and "declined" not in content:
                return self._step("", "web_research", {"query": f"buyers for {target}",
                                                       "num_results": 3})
            return self._create(messages, target)
        if name == "web_research":
            return self._create(messages, target)
        if name == "create_list":
            return self._reply(f"I built a strategic longlist for {target}.")
        return self._reply("Done.")

    def _create(self, messages: list[dict], target: str) -> ChatResult:
        hits = []
        for m in messages:  # the search result, if it had any companies
            if m.get("role") == "tool" and '"items"' in (m.get("content") or ""):
                hits = json.loads(m["content"]).get("items") or []
        entries = [*({"company_id": h["id"], "relevance_score": 70,
                      "relevance_explanation": "Found in our data."}
                     for h in hits[:2] if h.get("id")),
                   {"name": "Acme Consulting AG", "relevance_score": 60,
                    "relevance_explanation": "Adjacent IT services group."}]
        return self._step("", "create_list", {
            "name": f"{target} – Strategic buyers", "target": target,
            "kind": "strategic", "entries": entries})

    def _step(self, text: str, tool: str, arguments: dict[str, Any]) -> ChatResult:
        return ChatResult(text=text, tool_calls=[_call(tool, arguments)],
                          finish_reason="tool_calls", usage=_usage(self.model))

    def _reply(self, text: str) -> ChatResult:
        return ChatResult(text=text, finish_reason="stop", usage=_usage(self.model))


class FakeJudge:
    provider_name = "fake"
    model = "fake-judge"

    def complete(self, messages: list[dict], tools=None) -> ChatResult:
        verdict = {c: {"score": 3, "reason": "Fake judge."} for c in (
            "scoping", "relevance", "grounding", "no_invention",
            "criteria_fit", "evidence", "uncertainty")}
        return ChatResult(text=json.dumps(verdict), usage=_usage(self.model))
