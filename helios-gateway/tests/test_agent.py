"""Agent harness: event log, queueing, interrupt, privacy, Exa cap, ask_user,
list tools. Uses a scripted fake model — no real LLM or Exa calls."""

from __future__ import annotations

import json
import threading
import time
import uuid

import pytest
from fastapi.testclient import TestClient

from app.agent import runner as agent_runner
from app.agent.tools import EXA_CAP
from app.llm import ChatResult, ChatUsage
from tests.conftest import add_user, clear_corpus, sign_in


class ScriptedChat:
    """Returns queued ChatResults; records every complete() call."""

    provider_name = "fake"
    model = "fake-model"

    def __init__(self, scripts: list[ChatResult | dict]):
        self.scripts = list(scripts)
        self.calls: list[list[dict]] = []
        self._lock = threading.Lock()

    def complete(self, messages, tools=None) -> ChatResult:
        with self._lock:
            self.calls.append(messages)
            if not self.scripts:
                return ChatResult(
                    text="(no script left)",
                    usage=ChatUsage(provider="fake", model="fake-model",
                                    prompt_tokens=1, completion_tokens=1,
                                    total_tokens=2, latency_ms=1),
                )
            item = self.scripts.pop(0)
        if isinstance(item, ChatResult):
            return item
        tool_calls = []
        for tc in item.get("tool_calls") or []:
            tool_calls.append({
                "id": tc.get("id") or f"call_{uuid.uuid4().hex[:8]}",
                "type": "function",
                "function": {
                    "name": tc["name"],
                    "arguments": json.dumps(tc.get("arguments") or {}),
                },
            })
        return ChatResult(
            text=item.get("text") or "",
            tool_calls=tool_calls,
            finish_reason="tool_calls" if tool_calls else "stop",
            usage=ChatUsage(provider="fake", model="fake-model",
                            prompt_tokens=10, completion_tokens=5,
                            total_tokens=15, latency_ms=3, cost_usd=0.0),
        )


def _result(**kwargs) -> dict:
    return kwargs


@pytest.fixture
def app_(database):
    # Clear cached settings/providers so test env vars apply.
    from app import config, llm

    config.settings.cache_clear()
    llm.provider.cache_clear()
    llm.chat_provider.cache_clear()
    clear_corpus()
    add_user("alice@helbling.ch", name="Alice")
    add_user("bob@helbling.ch", name="Bob")
    from app.main import app

    yield app
    agent_runner.use_chat_factory(None)
    agent_runner.use_exa_search(None)


@pytest.fixture
def alice(app_):
    with TestClient(app_) as c:
        sign_in(c, "alice@helbling.ch")
        yield c


@pytest.fixture
def bob(app_):
    with TestClient(app_) as c:
        sign_in(c, "bob@helbling.ch")
        yield c


def install_script(scripts: list) -> ScriptedChat:
    fake = ScriptedChat(scripts)
    agent_runner.use_chat_factory(lambda: fake)
    agent_runner.use_exa_search(
        lambda q, n: [{"title": f"Hit for {q}", "url": "https://example.com",
                       "highlights": ["snippet"]}])
    return fake


def wait_idle(client, chat_id: str, timeout: float = 8.0) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        r = client.get(f"/sessions/{chat_id}")
        assert r.status_code == 200, r.text
        data = r.json()
        if data["status"] == "idle":
            return data
        time.sleep(0.05)
    raise AssertionError(f"session {chat_id} still running: {data}")


def types_of(session: dict) -> list[str]:
    return [e["type"] for e in session["events"]]


def test_privacy_other_user_gets_404(alice, bob):
    install_script([_result(text="Hello Alice")])
    r = alice.post("/sessions", json={"message": "hi"})
    assert r.status_code == 201, r.text
    chat_id = r.json()["id"]
    wait_idle(alice, chat_id)
    assert bob.get(f"/sessions/{chat_id}").status_code == 404
    assert bob.get("/sessions").json() == []
    assert alice.get("/sessions").json()[0]["id"] == chat_id


def test_event_log_and_end_turn(alice):
    install_script([_result(text="Here is a short answer.")])
    r = alice.post("/sessions", json={"message": "Ping"})
    chat = wait_idle(alice, r.json()["id"])
    assert chat["stop_reason"] == "end_turn"
    assert "user.message" in types_of(chat)
    assert "agent.message" in types_of(chat)
    assert "agent.model_usage" in types_of(chat)
    assert "session.status_running" in types_of(chat)
    assert "session.status_idle" in types_of(chat)
    msg = next(e for e in chat["events"] if e["type"] == "agent.message")
    assert msg["payload"]["text"] == "Here is a short answer."
    usage = next(e for e in chat["events"] if e["type"] == "agent.model_usage")
    assert usage["payload"]["provider"] == "fake"
    assert usage["payload"]["total_tokens"] == 15


def test_ask_user_round_trip(alice):
    install_script([
        _result(tool_calls=[{
            "name": "ask_user",
            "arguments": {
                "question": "Build longlists on this basis?",
                "options": ["Yes"],
            },
        }]),
        _result(text="Great, I'll start."),
    ])
    r = alice.post("/sessions", json={"message": "Acme: industrial sensors"})
    chat = wait_idle(alice, r.json()["id"])
    assert chat["stop_reason"] == "requires_action"
    assert chat["pending_ask"]["question"] == "Build longlists on this basis?"
    assert chat["pending_ask"]["options"] == ["Yes"]
    tool_call_id = chat["pending_ask"]["tool_call_id"]
    r2 = alice.post(f"/sessions/{chat['id']}/tool_results",
                    json={"tool_call_id": tool_call_id, "answer": "Yes"})
    assert r2.status_code == 201, r2.text
    chat = wait_idle(alice, chat["id"])
    assert chat["stop_reason"] == "end_turn"
    assert any(e["type"] == "user.tool_result" and e["payload"]["answer"] == "Yes"
               for e in chat["events"])
    assert any(e["type"] == "agent.message" and "Great" in e["payload"]["text"]
               for e in chat["events"])


def test_message_while_running_queues(alice):
    """A second message sent during the first turn is handled next."""
    gate = threading.Event()

    class SlowChat(ScriptedChat):
        def complete(self, messages, tools=None):
            # First call blocks until the test enqueues a second message.
            if len(self.calls) == 0:
                gate.wait(timeout=5)
            return super().complete(messages, tools)

    fake = SlowChat([
        _result(text="First reply"),
        _result(text="Second reply"),
    ])
    agent_runner.use_chat_factory(lambda: fake)

    r = alice.post("/sessions", json={"message": "one"})
    chat_id = r.json()["id"]
    # Wait until the loop is clearly running (or first complete about to block).
    deadline = time.time() + 3
    while time.time() < deadline:
        s = alice.get(f"/sessions/{chat_id}").json()
        if s["status"] == "running" or fake.calls:
            break
        time.sleep(0.02)
    alice.post(f"/sessions/{chat_id}/messages", json={"text": "two"})
    gate.set()
    chat = wait_idle(alice, chat_id, timeout=10)
    texts = [e["payload"]["text"] for e in chat["events"] if e["type"] == "agent.message"]
    assert texts == ["First reply", "Second reply"]
    users = [e["payload"]["text"] for e in chat["events"] if e["type"] == "user.message"]
    assert users == ["one", "two"]


def test_interrupt_stops_between_steps(alice):
    gate = threading.Event()

    class SlowThenMore(ScriptedChat):
        def complete(self, messages, tools=None):
            result = super().complete(messages, tools)
            # After the first tool result is applied, block before the next model call.
            if len(self.calls) == 1:
                gate.wait(timeout=5)
            return result

    fake = SlowThenMore([
        _result(tool_calls=[{
            "name": "corpus_search",
            "arguments": {"query": "PE Switzerland"},
        }]),
        _result(text="Should not appear if interrupted"),
    ])
    agent_runner.use_chat_factory(lambda: fake)
    agent_runner.use_exa_search(lambda q, n: [])

    r = alice.post("/sessions", json={"message": "search"})
    chat_id = r.json()["id"]
    deadline = time.time() + 4
    while time.time() < deadline:
        s = alice.get(f"/sessions/{chat_id}").json()
        if any(e["type"] == "agent.tool_result" for e in s["events"]):
            break
        time.sleep(0.05)
    alice.post(f"/sessions/{chat_id}/interrupt")
    gate.set()
    chat = wait_idle(alice, chat_id, timeout=10)
    assert chat["stop_reason"] == "interrupted"
    assert "user.interrupt" in types_of(chat)
    assert not any(
        e["type"] == "agent.message"
        and "Should not appear" in (e["payload"].get("text") or "")
        for e in chat["events"]
    )


def test_exa_cap_and_default_off(alice):
    install_script([
        _result(tool_calls=[{
            "name": "web_research",
            "arguments": {"query": "buyers"},
        }]),
        _result(text="Web was blocked."),
    ])
    r = alice.post("/sessions", json={"message": "try web"})
    chat = wait_idle(alice, r.json()["id"])
    results = [e for e in chat["events"] if e["type"] == "agent.tool_result"]
    assert results and "request_web_research" in results[0]["payload"]["content"]

    # Enable via request_web_research (session), then hit the cap.
    from app.agent.tools import OPT_ALLOW_CHAT

    calls = [
        _result(tool_calls=[{
            "name": "request_web_research",
            "arguments": {
                "scope": "session",
                "reason": "Allow web for this chat?",
            },
        }]),
    ]
    for i in range(EXA_CAP + 1):
        calls.append(_result(tool_calls=[{
            "name": "web_research",
            "arguments": {"query": f"q{i}"},
        }]))
    calls.append(_result(text="Done searching."))
    install_script(calls)
    r = alice.post("/sessions", json={"message": "second pass"})
    chat = wait_idle(alice, r.json()["id"])
    assert chat["stop_reason"] == "requires_action"
    assert chat["pending_ask"]["grant"] == "web_research"
    assert chat["pending_ask"]["scope"] == "session"
    alice.post(f"/sessions/{chat['id']}/tool_results", json={
        "tool_call_id": chat["pending_ask"]["tool_call_id"],
        "answer": OPT_ALLOW_CHAT,
    })
    chat = wait_idle(alice, chat["id"], timeout=15)
    web_results = [
        e for e in chat["events"]
        if e["type"] == "agent.tool_result" and e["payload"].get("name") == "web_research"
    ]
    assert len(web_results) == EXA_CAP + 1
    assert "cap reached" in web_results[-1]["payload"]["content"]
    assert chat["web_research_enabled"] is True


def test_web_research_query_grant(alice):
    from app.agent.tools import OPT_ALLOW_QUERY

    searches: list[str] = []

    def fake_exa(q, n):
        searches.append(q)
        return [{"title": q, "url": f"https://example.com/{q}", "text": "ok"}]

    install_script([
        _result(tool_calls=[{
            "name": "request_web_research",
            "arguments": {
                "scope": "query",
                "query": "Anybotics overview",
                "reason": "Look up Anybotics on the web?",
            },
        }]),
        _result(tool_calls=[{
            "name": "web_research",
            "arguments": {"query": "Anybotics overview"},
        }]),
        _result(tool_calls=[{
            "name": "web_research",
            "arguments": {"query": "different query"},
        }]),
        _result(text="Done."),
    ])
    agent_runner.use_exa_search(fake_exa)
    r = alice.post("/sessions", json={"message": "anybotics"})
    chat = wait_idle(alice, r.json()["id"])
    assert chat["stop_reason"] == "requires_action"
    ask = chat["pending_ask"]
    assert ask["grant"] == "web_research_query"
    assert ask["query"] == "Anybotics overview"
    assert OPT_ALLOW_QUERY in ask["options"]
    alice.post(f"/sessions/{chat['id']}/tool_results", json={
        "tool_call_id": ask["tool_call_id"], "answer": OPT_ALLOW_QUERY,
    })
    chat = wait_idle(alice, chat["id"])
    web_results = [
        e for e in chat["events"]
        if e["type"] == "agent.tool_result" and e["payload"].get("name") == "web_research"
    ]
    assert len(web_results) == 2
    assert "results" in web_results[0]["payload"]["content"]
    assert "request_web_research" in web_results[1]["payload"]["content"]
    assert searches == ["Anybotics overview"]
    assert chat["web_research_enabled"] is False


def test_web_research_turn_grant(alice):
    from app.agent.tools import OPT_ALLOW_TURN

    def fake_exa(q, n):
        return [{"title": q, "url": "https://example.com", "text": "ok"}]

    install_script([
        _result(tool_calls=[{
            "name": "request_web_research",
            "arguments": {
                "scope": "turn",
                "reason": "Allow web for this turn?",
            },
        }]),
        _result(tool_calls=[{
            "name": "web_research",
            "arguments": {"query": "a"},
        }]),
        _result(text="Turn done."),
    ])
    agent_runner.use_exa_search(fake_exa)
    r = alice.post("/sessions", json={"message": "turn grant"})
    chat = wait_idle(alice, r.json()["id"])
    assert chat["pending_ask"]["grant"] == "web_research_once"
    alice.post(f"/sessions/{chat['id']}/tool_results", json={
        "tool_call_id": chat["pending_ask"]["tool_call_id"],
        "answer": OPT_ALLOW_TURN,
    })
    chat = wait_idle(alice, chat["id"])
    assert chat["stop_reason"] == "end_turn"
    assert any(
        e["type"] == "agent.tool_result" and e["payload"].get("name") == "web_research"
        and "results" in e["payload"]["content"]
        for e in chat["events"]
    )
    # Turn grant is cleared after end_turn; a new run must request again.
    install_script([
        _result(tool_calls=[{
            "name": "web_research",
            "arguments": {"query": "b"},
        }]),
        _result(text="Blocked again."),
    ])
    alice.post(f"/sessions/{chat['id']}/messages", json={"text": "again"})
    chat = wait_idle(alice, chat["id"])
    blocked = [
        e for e in chat["events"]
        if e["type"] == "agent.tool_result" and e["payload"].get("name") == "web_research"
        and "request_web_research" in e["payload"]["content"]
    ]
    assert blocked


def test_create_and_update_list_tools(alice):
    # Rows without a corpus company_id keep their name on the list itself.
    class ListScript(ScriptedChat):
        def complete(self, messages, tools=None):
            if len(self.calls) == 1 and self.scripts:
                list_id = None
                for m in messages:
                    if m.get("role") == "tool":
                        try:
                            data = json.loads(m.get("content") or "{}")
                        except json.JSONDecodeError:
                            continue
                        if data.get("list_id"):
                            list_id = data["list_id"]
                if list_id:
                    nxt = self.scripts[0]
                    if isinstance(nxt, dict):
                        for tc in nxt.get("tool_calls") or []:
                            if tc.get("name") == "update_list":
                                tc["arguments"]["list_id"] = list_id
            return super().complete(messages, tools)

    fake = ListScript([
        _result(tool_calls=[{
            "name": "create_list",
            "arguments": {
                "name": "Acme – Financial buyers",
                "target": "Acme",
                "kind": "financial",
                "entries": [{
                    "name": "BWK GmbH",
                    "relevance_score": 88,
                    "relevance_explanation": "Fits ticket and sector.",
                }],
            },
        }]),
        _result(tool_calls=[{
            "name": "update_list",
            "arguments": {
                "list_id": "00000000-0000-0000-0000-000000000000",
                "message": "Added the Sauvignon column",
                "ops": [{"op": "add_column", "label": "Owner likes Sauvignon"}],
            },
        }]),
        _result(text="List is ready."),
    ])
    agent_runner.use_chat_factory(lambda: fake)

    r = alice.post("/sessions", json={"message": "Build a list"})
    chat = wait_idle(alice, r.json()["id"], timeout=12)
    assert chat["stop_reason"] == "end_turn"
    assert chat["list_ids"], chat
    list_id = chat["list_ids"][0]
    table = alice.get(f"/longlists/{list_id}").json()
    assert table["name"] == "Acme – Financial buyers"
    assert table["size"] >= 1
    assert any(c["label"] == "Owner likes Sauvignon" for c in table["columns"])
    versions = alice.get(f"/longlists/{list_id}/versions").json()
    assert any(v["author"] == "agent" for v in versions)


def test_create_list_coerces_string_entries(alice):
    """Models often emit entries as bare names; that must not crash the run."""
    install_script([
        _result(tool_calls=[{
            "name": "create_list",
            "arguments": {
                "name": "Anybotics – Financial buyers",
                "target": "Anybotics",
                "kind": "financial",
                "entries": ["SoftBank Vision Fund", "EQT"],
            },
        }]),
        _result(text="Created with name-only rows."),
    ])
    r = alice.post("/sessions", json={"message": "list"})
    chat = wait_idle(alice, r.json()["id"])
    assert chat["stop_reason"] == "end_turn"
    assert chat["list_ids"]
    # No session.error from AttributeError.
    assert "session.error" not in types_of(chat)
    table = alice.get(f"/longlists/{chat['list_ids'][0]}").json()
    assert table["size"] >= 2


def test_create_list_bad_entries_are_tool_errors(alice):
    install_script([
        _result(tool_calls=[{
            "name": "create_list",
            "arguments": {
                "name": "Broken",
                "entries": [42, True],
            },
        }]),
        _result(text="I'll fix the entries."),
    ])
    r = alice.post("/sessions", json={"message": "list"})
    chat = wait_idle(alice, r.json()["id"])
    assert chat["stop_reason"] == "end_turn"
    assert "session.error" not in types_of(chat)
    err = next(
        e for e in chat["events"]
        if e["type"] == "agent.tool_result" and e["payload"].get("name") == "create_list"
    )
    assert "error" in err["payload"]["content"]
    assert err["payload"]["is_error"] is True
    assert "entries.0" in err["payload"]["content"]
    assert alice.get("/longlists").json() == [] or all(
        lst["name"] != "Broken" for lst in alice.get("/longlists").json())


def test_parse_tool_arguments_double_encoded():
    from app.agent.tools import parse_tool_arguments

    assert parse_tool_arguments('{"query": "x"}') == {"query": "x"}
    assert parse_tool_arguments('{"query": "x"}') == {"query": "x"}
    # Double-encoded JSON string (common provider quirk).
    inner = json.dumps({"query": "x"})
    assert parse_tool_arguments(json.dumps(inner)) == {"query": "x"}
    assert parse_tool_arguments({"query": "x"}) == {"query": "x"}
    # Not an object: kept for validation to reject with a clear message.
    assert parse_tool_arguments(None) == {"_raw": None}
    assert parse_tool_arguments("[1, 2]") == {"_raw": "[1, 2]"}


def test_pin_rename_delete(alice):
    install_script([_result(text="ok")])
    chat_id = alice.post("/sessions", json={"message": "x"}).json()["id"]
    wait_idle(alice, chat_id)
    r = alice.patch(f"/sessions/{chat_id}", json={"title": "Renamed", "pinned": True})
    assert r.status_code == 200
    assert r.json()["title"] == "Renamed"
    assert r.json()["pinned"] is True
    assert alice.delete(f"/sessions/{chat_id}").status_code == 204
    assert alice.get(f"/sessions/{chat_id}").status_code == 404


def test_stream_replays_then_goes_live_and_unsubscribes(app_, alice):
    """A real server (TestClient buffers streaming bodies): the backlog after
    `after`, then live events; an open stream doesn't block other requests,
    and closing it unsubscribes."""
    import socket

    import httpx
    import uvicorn

    from app.agent.bus import bus

    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    server = uvicorn.Server(uvicorn.Config(app_, port=port, log_level="warning",
                                           lifespan="off"))
    threading.Thread(target=server.run, daemon=True).start()
    base = f"http://127.0.0.1:{port}"
    deadline = time.time() + 5
    while not server.started and time.time() < deadline:
        time.sleep(0.02)

    install_script([_result(text="First."), _result(text="Second.")])
    chat_id = alice.post("/sessions", json={"message": "One"}).json()["id"]
    wait_idle(alice, chat_id)
    headers = {"Authorization": alice.headers["Authorization"]}
    seen: list[dict] = []
    try:
        with httpx.stream("GET", f"{base}/sessions/{chat_id}/stream?after=1",
                          headers=headers, timeout=10) as r:
            assert r.headers["content-type"].startswith("text/event-stream")
            sent = False
            for line in r.iter_lines():
                if not line.startswith("data:"):
                    continue
                seen.append(json.loads(line[5:]))
                if seen[-1]["type"] != "session.status_idle":
                    continue
                if sent:
                    break
                # Live from here, and other requests aren't blocked.
                assert httpx.get(f"{base}/health", timeout=2).status_code == 200
                assert alice.post(f"/sessions/{chat_id}/messages",
                                  json={"text": "Two"}).status_code < 300
                sent = True
        seqs = [e["seq"] for e in seen if e.get("seq") is not None]
        assert seqs == sorted(set(seqs))
        assert seqs[0] == 2
        texts = [e["payload"]["text"] for e in seen if e["type"] == "agent.message"]
        assert texts == ["First.", "Second."]
        deadline = time.time() + 3
        while bus._subs.get(uuid.UUID(chat_id)) and time.time() < deadline:
            time.sleep(0.05)
        assert not bus._subs.get(uuid.UUID(chat_id))
    finally:
        server.should_exit = True


# ── Review fixes: one test per bug ─────────────────────────────────────────


def assert_valid_history(messages: list[dict]) -> None:
    """What the chat APIs require: every tool call answered right after its
    assistant message, and no tool message without its call."""
    open_calls: list[str] = []
    for m in messages:
        if m["role"] == "tool":
            assert open_calls and m["tool_call_id"] == open_calls.pop(0), messages
            continue
        assert not open_calls, f"unanswered tool calls {open_calls}: {messages}"
        if m["role"] == "assistant" and m.get("tool_calls"):
            open_calls = [c["id"] for c in m["tool_calls"]]
    assert not open_calls, messages


def test_concurrent_appends_get_distinct_seqs(alice):
    """The API and the run thread write the log at the same time."""
    from app.agent import events as ev
    from app.db import session_scope

    install_script([_result(text="ok")])
    chat_id = uuid.UUID(alice.post("/sessions", json={"message": "x"}).json()["id"])
    wait_idle(alice, str(chat_id))
    errors: list[Exception] = []

    def writer(n: int) -> None:
        try:
            for i in range(10):
                with session_scope() as s:
                    ev.append(s, chat_id, ev.MODEL_USAGE, {"writer": n, "i": i})
        except Exception as e:  # noqa: BLE001 - any failure fails the assert below
            errors.append(e)

    threads = [threading.Thread(target=writer, args=(n,)) for n in range(6)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert errors == []
    seqs = [e["seq"] for e in alice.get(f"/sessions/{chat_id}").json()["events"]]
    assert seqs == list(range(1, len(seqs) + 1))


def test_failed_tool_call_leaves_no_writes(alice):
    """A create_list that fails validation half-way must not leave an empty
    list behind (each tool call runs in a savepoint)."""
    install_script([
        _result(tool_calls=[{"name": "create_list", "arguments": {
            "name": "Half-made list",
            "entries": [{"name": "Good AG"},
                        {"name": "Bad AG", "values": {"revenue": "lots"}}]}}]),
        _result(text="I'll fix that."),
    ])
    chat = wait_idle(alice, alice.post("/sessions", json={"message": "x"}).json()["id"])
    result = next(e for e in chat["events"] if e["type"] == "agent.tool_result")
    assert result["payload"]["is_error"] is True
    assert "entries.1.values.revenue" in result["payload"]["content"]
    assert chat["list_ids"] == []
    assert all(lst["name"] != "Half-made list" for lst in alice.get("/longlists").json())
    assert "session.error" not in types_of(chat)


def test_message_during_tool_step_is_answered_once(alice):
    """A message sent while tools run joins the next model call and is
    marked handled there: no extra turn answering it again."""
    gate = threading.Event()

    class Slow(ScriptedChat):
        def complete(self, messages, tools=None):
            if not self.calls:
                gate.wait(5)
            return super().complete(messages, tools)

    fake = Slow([
        _result(tool_calls=[{"name": "corpus_search", "arguments": {"query": "a"}}]),
        _result(text="Answered both."),
        _result(text="A redundant second answer."),
    ])
    agent_runner.use_chat_factory(lambda: fake)
    chat_id = alice.post("/sessions", json={"message": "one"}).json()["id"]
    assert alice.post(f"/sessions/{chat_id}/messages", json={"text": "two"}).status_code == 201
    gate.set()
    chat = wait_idle(alice, chat_id)
    assert len(fake.calls) == 2
    assert [e["payload"]["text"] for e in chat["events"]
            if e["type"] == "agent.message"] == ["Answered both."]
    for call in fake.calls:
        assert_valid_history(call)


def test_stop_while_a_question_is_open_keeps_the_chat_usable(alice):
    """The question's tool call never gets an answer; the history sent to
    the model still answers it (placeholder), so the next message works."""
    install_script([
        _result(tool_calls=[{"name": "ask_user", "arguments": {
            "question": "Which geography?", "options": ["Europe", "World"]}}]),
    ])
    chat_id = alice.post("/sessions", json={"message": "list"}).json()["id"]
    assert wait_idle(alice, chat_id)["stop_reason"] == "requires_action"
    # Simulate the card going away without an answer (e.g. a failed run).
    from app.db import session_scope
    from app.models import ChatSession

    with session_scope() as s:
        chat = s.get(ChatSession, uuid.UUID(chat_id))
        chat.pending_tool_call_id = None
        chat.stop_reason = "error"
    fake = install_script([_result(text="Carrying on.")])
    alice.post(f"/sessions/{chat_id}/messages", json={"text": "Europe, please"})
    chat = wait_idle(alice, chat_id)
    assert chat["stop_reason"] == "end_turn"
    history = fake.calls[0]
    assert_valid_history(history)
    tool = next(m for m in history if m["role"] == "tool")
    assert "didn't answer" in tool["content"]


def test_wake_while_winding_down_runs_again(app_, monkeypatch):
    """A user event committed while the thread is finishing is not lost."""
    chat_id = uuid.uuid4()
    calls: list[int] = []
    done = threading.Event()

    def fake_run(cid):
        calls.append(1)
        if len(calls) == 1:
            agent_runner.wake(cid)  # arrives before the thread exits
        else:
            done.set()

    monkeypatch.setattr(agent_runner, "_run", fake_run)
    agent_runner.wake(chat_id)
    assert done.wait(3)
    deadline = time.time() + 2
    while chat_id in agent_runner._running and time.time() < deadline:
        time.sleep(0.01)
    assert len(calls) == 2
    assert chat_id not in agent_runner._running


def test_typed_text_on_the_web_card_is_not_consent(alice):
    install_script([
        _result(tool_calls=[{"name": "request_web_research", "arguments": {
            "scope": "session", "reason": "Search the web?"}}]),
        _result(text="Okay."),
    ])
    chat_id = alice.post("/sessions", json={"message": "x"}).json()["id"]
    wait_idle(alice, chat_id)
    alice.post(f"/sessions/{chat_id}/messages", json={"text": "What would you search?"})
    chat = wait_idle(alice, chat_id)
    assert chat["web_research_enabled"] is False
    answer = next(e for e in chat["events"] if e["type"] == "user.tool_result")
    assert answer["payload"]["granted"] is None
    assert "didn't approve" in answer["payload"]["for_model"]


def test_read_list_then_refine_by_row_id_and_label(alice):
    """The refine skill's path: read the list, then set and remove by row id
    and column label, one new version."""
    install_script([
        _result(tool_calls=[{"name": "create_list", "arguments": {
            "name": "Refine me", "kind": "financial", "entries": [
                {"name": "Alpha Capital", "relevance_score": 80,
                 "values": {"hq": "Zurich, Switzerland"}},
                {"name": "Beta Partners", "relevance_score": 60,
                 "values": {"hq": "Boston, USA"}}]}}]),
        _result(text="Created."),
    ])
    chat = wait_idle(alice, alice.post("/sessions", json={"message": "x"}).json()["id"])
    list_id = chat["list_ids"][0]
    agent_runner.use_exa_search(None)

    class Refine(ScriptedChat):
        def complete(self, messages, tools=None):
            last = messages[-1]
            if last["role"] == "tool" and '"rows"' in last["content"]:
                rows = json.loads(last["content"])["rows"]
                by_name = {r["values"]["name"]: r["row_id"] for r in rows}
                self.scripts.insert(0, _result(tool_calls=[{
                    "name": "update_list", "arguments": {
                        "list_id": list_id, "message": "Europe only",
                        "ops": [
                            {"op": "add_column", "label": "Owner likes Sauvignon"},
                            {"op": "set_cell", "row_id": by_name["Alpha Capital"],
                             "column": "Owner likes Sauvignon", "value": "Yes"},
                            {"op": "remove_row", "row_id": by_name["Beta Partners"]},
                        ]}}]))
            return super().complete(messages, tools)

    fake = Refine([
        _result(tool_calls=[{"name": "read_list", "arguments": {"list_id": list_id}}]),
        _result(text="Done."),
    ])
    agent_runner.use_chat_factory(lambda: fake)
    alice.post(f"/sessions/{chat['id']}/messages", json={"text": "Europe only"})
    chat = wait_idle(alice, chat["id"])
    update = [e for e in chat["events"] if e["type"] == "agent.tool_result"
              and e["payload"]["name"] == "update_list"][-1]
    assert update["payload"]["is_error"] is False, update
    table = alice.get(f"/longlists/{list_id}").json()
    assert [r["cells"]["name"]["value"] for r in table["rows"]] == ["Alpha Capital"]
    key = next(c["key"] for c in table["columns"] if c["label"] == "Owner likes Sauvignon")
    assert table["rows"][0]["cells"][key]["value"] == "Yes"
    assert table["version"] == 2


def test_same_tool_failing_repeatedly_is_switched_off(alice):
    bad = {"name": "corpus_search", "arguments": {"limit": 5}}  # no query or filter
    fake = install_script([_result(tool_calls=[bad]) for _ in range(4)]
                          + [_result(text="I'll tell the user.")])
    chat = wait_idle(alice, alice.post("/sessions", json={"message": "x"}).json()["id"])
    results = [e["payload"] for e in chat["events"] if e["type"] == "agent.tool_result"]
    assert len(results) == 4 and all(r["is_error"] for r in results)
    assert "give a query, at least one filter, or both" in results[0]["content"]
    assert "off for the rest of this run" in results[3]["content"]
    assert len(fake.calls) == 5


def test_stop_mid_stream_keeps_the_text_so_far(alice):
    from app.llm import ChatEvent

    started = threading.Event()
    release = threading.Event()

    class Streaming:
        provider_name, model = "fake", "fake-model"

        def stream(self, messages, tools=None):
            yield ChatEvent(kind="text_delta", text="Partial ")
            yield ChatEvent(kind="text_delta", text="answer")
            started.set()
            release.wait(5)
            yield ChatEvent(kind="text_delta", text=" that never shows")
            yield ChatEvent(kind="done", finish_reason="stop", latency_ms=5)

    agent_runner.use_chat_factory(lambda: Streaming())
    chat_id = alice.post("/sessions", json={"message": "x"}).json()["id"]
    assert started.wait(5)
    alice.post(f"/sessions/{chat_id}/interrupt")
    release.set()
    chat = wait_idle(alice, chat_id)
    assert chat["stop_reason"] == "interrupted"
    msg = next(e for e in chat["events"] if e["type"] == "agent.message")
    assert msg["payload"] == {**msg["payload"], "text": "Partial answer", "interrupted": True}


def test_config_versions_follow_the_files(app_, monkeypatch):
    """A chat keeps the config (prompt and skill texts) it started with; an
    edit to the files makes a new version without a migration."""
    from app.agent import config as agent_config
    from app.db import session_scope
    from app.models import AgentConfig

    with session_scope() as s:
        first = agent_config.current_version(s)
        assert agent_config.current_version(s) == first
        stored = s.get(AgentConfig, first)
        assert stored.skills[0]["name"] == "build_list" and stored.skills[0]["text"]
    original = agent_config.spec

    def edited():
        spec = original()
        return {**spec, "system_prompt": spec["system_prompt"] + "\nBe brief."}

    monkeypatch.setattr(agent_config, "spec", edited)
    with session_scope() as s:
        second = agent_config.current_version(s)
        assert second == first + 1
        assert s.get(AgentConfig, first).system_prompt != s.get(
            AgentConfig, second).system_prompt


def test_deleting_a_running_chat_ends_its_run_quietly(alice):
    gate = threading.Event()

    class Slow(ScriptedChat):
        def complete(self, messages, tools=None):
            gate.wait(5)
            return super().complete(messages, tools)

    fake = Slow([_result(text="too late")])
    agent_runner.use_chat_factory(lambda: fake)
    chat_id = uuid.UUID(alice.post("/sessions", json={"message": "x"}).json()["id"])
    assert alice.delete(f"/sessions/{chat_id}").status_code == 204
    gate.set()
    deadline = time.time() + 3
    while chat_id in agent_runner._running and time.time() < deadline:
        time.sleep(0.02)
    assert chat_id not in agent_runner._running
    assert alice.get(f"/sessions/{chat_id}").status_code == 404


def test_older_tool_results_are_compacted_for_the_model(alice):
    """Keeps each model call small (tokens-per-minute limits); the log keeps
    every result in full."""
    from app.agent.runner import FULL_RESULTS
    from app.agent.tools import OPT_ALLOW_CHAT

    def exa(q, n):
        return [{"title": f"T {q}", "url": "https://example.com",
                 "highlights": ["long snippet " * 20]}]

    calls = [_result(tool_calls=[{"name": "request_web_research", "arguments": {
        "scope": "session", "reason": "Search the web?"}}])]
    calls += [_result(tool_calls=[{"name": "web_research", "arguments": {"query": f"q{i}"}}])
              for i in range(FULL_RESULTS + 2)]
    calls.append(_result(text="Done."))
    fake = install_script(calls)
    agent_runner.use_exa_search(exa)
    chat = wait_idle(alice, alice.post("/sessions", json={"message": "x"}).json()["id"])
    alice.post(f"/sessions/{chat['id']}/tool_results", json={
        "tool_call_id": chat["pending_ask"]["tool_call_id"], "answer": OPT_ALLOW_CHAT})
    chat = wait_idle(alice, chat["id"])
    last = fake.calls[-1]
    assert_valid_history(last)
    web = [m["content"] for m in last if m["role"] == "tool" and "results" in m["content"]]
    assert len(web) == FULL_RESULTS + 2
    assert "snippet" not in web[0] and "T q0" in web[0]
    assert all("snippet" in c for c in web[-FULL_RESULTS:])
    stored = [e for e in chat["events"] if e["type"] == "agent.tool_result"
              and e["payload"]["name"] == "web_research"]
    assert "snippet" in stored[0]["payload"]["content"]


def test_the_list_read_this_turn_stays_in_full(alice):
    """Scoring a list: read_list, then many searches in one step. The rows must
    survive compaction until the agent writes; a later turn compacts them."""
    from app.agent.runner import FULL_RESULTS

    install_script([
        _result(tool_calls=[{"name": "create_list", "arguments": {
            "name": "Score me", "kind": "strategic", "entries": [
                {"name": "Alpha Systems"}, {"name": "Beta Consulting"}]}}]),
        _result(text="Created."),
    ])
    chat = wait_idle(alice, alice.post("/sessions", json={"message": "x"}).json()["id"])
    list_id = chat["list_ids"][0]
    searches = [{"name": "corpus_search", "arguments": {"query": f"q{i}"}}
                for i in range(FULL_RESULTS + 2)]
    fake = install_script([
        _result(tool_calls=[{"name": "read_list", "arguments": {"list_id": list_id}}]),
        _result(tool_calls=searches),
        _result(text="Scored."),
        _result(text="Later."),
    ])
    alice.post(f"/sessions/{chat['id']}/messages", json={"text": "Score them"})
    chat = wait_idle(alice, chat["id"])

    def read(messages):
        ids = {c["id"] for m in messages for c in m.get("tool_calls") or []
               if c["function"]["name"] == "read_list"}
        return next(json.loads(m["content"]) for m in messages
                    if m["role"] == "tool" and m["tool_call_id"] in ids)

    last = fake.calls[2]
    assert_valid_history(last)
    assert [r["values"]["name"] for r in read(last)["rows"]] == [
        "Alpha Systems", "Beta Consulting"]
    alice.post(f"/sessions/{chat['id']}/messages", json={"text": "Thanks"})
    wait_idle(alice, chat["id"])
    assert "rows" not in read(fake.calls[3]) and "note" in read(fake.calls[3])


def test_list_values_are_scored_by_their_source(alice):
    """Web facts with a page are Medium at best, unsourced agent facts Low, a
    person's edit High, a value with no record Unknown. Score and rationale
    come right after the list's main column."""
    install_script([
        _result(tool_calls=[{"name": "create_list", "arguments": {
            "name": "Sourced", "kind": "strategic", "entries": [
                {"name": "Sourced AG", "relevance_score": 70,
                 "relevance_explanation": "Fits.",
                 "values": {"sector": "Robotics", "hq": "Zurich, Switzerland"},
                 "source_url": "https://example.com/sourced"},
                {"name": "Unsourced AG", "values": {"sector": "Robotics"}}]}}]),
        _result(text="Created."),
    ])
    chat = wait_idle(alice, alice.post("/sessions", json={"message": "x"}).json()["id"])
    list_id = chat["list_ids"][0]
    table = alice.get(f"/longlists/{list_id}").json()
    keys = [c["key"] for c in table["columns"]]
    assert keys[:4] == ["name", "sector", "relevance_explanation", "relevance_score"]
    rows = {r["cells"]["name"]["value"]: r for r in table["rows"]}
    sourced = rows["Sourced AG"]["cells"]["sector"]
    assert sourced["source"] == "Public web" and sourced["level"] == "medium"
    assert sourced["url"] == "https://example.com/sourced"
    assert sourced["added"]["name"] == "Agent"
    unsourced = rows["Unsourced AG"]["cells"]["sector"]
    assert unsourced["source"] == "Agent, no source" and unsourced["level"] == "low"
    assert "level" not in rows["Sourced AG"]["cells"]["relevance_score"]

    entry = rows["Unsourced AG"]["id"]
    r = alice.post(f"/longlists/{list_id}/changes", json={"ops": [
        {"op": "set", "entry_id": entry, "key": "sector", "value": "Medtech"}]})
    assert r.status_code == 200, r.text
    edited = next(x for x in r.json()["rows"] if x["id"] == entry)["cells"]["sector"]
    assert edited["source"] == "Manual edit" and edited["level"] == "high"
    assert edited["manual"]["name"] == "Alice"

    # A value written before provenance was kept reads as Unknown.
    from app.db import session_scope
    from app.models import ListEntryState

    with session_scope() as s:
        state = s.query(ListEntryState).filter(
            ListEntryState.entry_id == uuid.UUID(entry),
            ListEntryState.valid_to.is_(None)).one()
        state.provenance = {}
    old = next(x for x in alice.get(f"/longlists/{list_id}").json()["rows"]
               if x["id"] == entry)["cells"]["sector"]
    assert old["level"] == "unknown" and old["source"] == "Unknown source"


def test_header_toggle_turns_web_search_on_and_off(alice, bob):
    searches: list[str] = []
    fake = install_script([_result(text="Hi."), _result(tool_calls=[{
        "name": "web_research", "arguments": {"query": "Anybotics"}}]),
        _result(text="Found it."),
        _result(tool_calls=[{"name": "web_research", "arguments": {"query": "again"}}]),
        _result(text="Blocked.")])
    agent_runner.use_exa_search(
        lambda q, n: searches.append(q) or [{"title": q, "url": "https://example.com"}])
    chat_id = alice.post("/sessions", json={"message": "hello"}).json()["id"]
    wait_idle(alice, chat_id)

    # On: a click is consent, so the agent may search without a card.
    r = alice.post(f"/sessions/{chat_id}/web_access", json={"enabled": True})
    assert r.status_code == 201, r.text
    assert r.json()["session"]["web_research_enabled"] is True
    assert r.json()["event"]["type"] == "user.web_access"
    alice.post(f"/sessions/{chat_id}/messages", json={"text": "look it up"})
    wait_idle(alice, chat_id)
    assert searches == ["Anybotics"]
    assert any("turned web search on" in (m.get("content") or "")
               for m in fake.calls[1])

    # Off: the next search is refused until approved again.
    r = alice.post(f"/sessions/{chat_id}/web_access", json={"enabled": False})
    assert r.json()["session"]["web_research_enabled"] is False
    alice.post(f"/sessions/{chat_id}/messages", json={"text": "once more"})
    wait_idle(alice, chat_id)
    assert searches == ["Anybotics"]

    # Someone else's chat: 404.
    assert bob.post(f"/sessions/{chat_id}/web_access",
                    json={"enabled": True}).status_code == 404


def test_read_list_leaves_out_contacts(app_, monkeypatch):
    """The agent doesn't see contacts: read_list drops the column and its
    values; setting or adding it is a tool error."""
    from app.agent import tools
    from app.db import session_scope
    from app.longlists import AddEntry, create_list, table
    from app.models import ChatSession, Longlist
    from app.seed_contacts import ContactSpec, write_contacts
    from tests.conftest import install_fake_llm
    from tests.test_flow import run_import

    install_fake_llm(monkeypatch)
    add_user("dev@helbling.ch", role="dev")
    with TestClient(app_) as c:
        sign_in(c, "dev@helbling.ch")
        run_import(c, "internal_longlist.xlsx")
        cid = uuid.UUID(c.get("/companies", params={"q": "BWK"}).json()["items"][0]["id"])
    with session_scope() as s:
        write_contacts(s, [ContactSpec(company_id=cid, first_name="Petra",
                                       last_name="Lang")], "test@helbling.ch")
        lst, _ = create_list(s, name="Agent view", owner="alice@helbling.ch",
                             kind="financial",
                             ops=[AddEntry(op="add_entry", company_id=cid)])
        list_id = str(lst.id)
    chat = ChatSession(owner="alice@helbling.ch", list_ids=[])

    def update(s, op: dict):
        out = tools.run_tool(s, chat, "update_list",
                             {"list_id": list_id, "message": "x", "ops": [op]})
        assert out.is_error, out
        return json.loads(out.content)["error"]

    with session_scope() as s:
        lst = s.get(Longlist, uuid.UUID(list_id))
        assert table(s, lst)["rows"][0]["cells"]["contacts"]["value"] == [
            "Dr. Anna Muster", "Petra Lang"]
        head = lst.head_version
        read = tools.run_tool(s, chat, "read_list", {"list_id": list_id})
        out = json.loads(read.content)
        row_id = out["rows"][0]["row_id"]
        errors = [update(s, op) for op in (
            {"op": "set_cell", "row_id": row_id, "column": "contacts", "value": "X"},
            {"op": "set_cell", "row_id": row_id, "column": "Contacts", "value": "X"},
            {"op": "remove_column", "column": "contacts"},
            {"op": "remove_column", "column": "Contacts"})]
        add_column = update(s, {"op": "add_column", "key": "contacts"})
        s.refresh(lst)
        assert lst.head_version == head  # nothing was written
    assert not read.is_error
    assert "contacts" not in [c["key"] for c in out["columns"]]
    assert "contacts" not in out["rows"][0]["values"]
    assert out["rows"][0]["values"]["name"].startswith("BWK")
    # An unknown column to the agent; the error lists the columns it can see.
    for error in errors:
        assert error.startswith("No column ") and "Contacts" not in error.split(
            "Columns:")[1], error
    assert "ops.0" in add_column


def test_agent_sees_ranges_as_text(app_, monkeypatch):
    """Employees are a range in the data; the agent reads and writes text."""
    from app.agent import tools
    from app.db import session_scope
    from app.longlists import AddEntry, create_list
    from app.models import ChatSession
    from tests.conftest import install_fake_llm
    from tests.test_flow import run_import

    install_fake_llm(monkeypatch)
    add_user("dev@helbling.ch", role="dev")
    with TestClient(app_) as c:
        sign_in(c, "dev@helbling.ch")
        run_import(c, "internal_longlist.xlsx")
        cid = uuid.UUID(c.get("/companies", params={"q": "BWK"}).json()["items"][0]["id"])
    chat = ChatSession(owner="alice@helbling.ch", list_ids=[])
    with session_scope() as s:
        lst, _ = create_list(s, name="Ranges", owner="alice@helbling.ch",
                             kind="financial",
                             ops=[AddEntry(op="add_entry", company_id=cid),
                                  AddEntry(op="add_entry", values={"name": "Solo AG"})])
        list_id = str(lst.id)

    def run(s, name, args):
        out = tools.run_tool(s, chat, name, args)
        assert not out.is_error, out.content
        return json.loads(out.content)

    with session_scope() as s:
        read = run(s, "read_list", {"list_id": list_id})
        rows = {r["values"]["name"]: r["row_id"] for r in read["rows"]}
        bwk = next(v for k, v in rows.items() if k.startswith("BWK"))
        run(s, "update_list", {"list_id": list_id, "message": "Employees", "ops": [
            {"op": "set_cell", "row_id": bwk, "column": "employee_count",
             "value": "11-50"},
            {"op": "set_cell", "row_id": rows["Solo AG"], "column": "employee_count",
             "value": "50-200"}]})
        raw = tools.run_tool(s, chat, "read_list", {"list_id": list_id}).content
        read = json.loads(raw)
        values = {r["values"]["name"]: r["values"]["employee_count"]
                  for r in read["rows"]}
        assert values["Solo AG"] == "50–200"
        assert values[next(k for k in values if k.startswith("BWK"))] == "11–50"
        assert '"low"' not in raw
        found = tools.run_tool(s, chat, "corpus_search", {"query": "BWK"}).content
        assert '"low"' not in found
        assert json.loads(found)["items"][0]["employee_count"] == "11–50"
