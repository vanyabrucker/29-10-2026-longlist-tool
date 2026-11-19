"""Inspect tasks for the Helios agent, one model per run.

    uv run inspect eval evals/helios_eval.py@helios_replay -T agent_model=deepseek \
        --log-dir evals/logs          # chosen real chats, replayed
    uv run inspect eval evals/helios_eval.py@helios_scenarios -T agent_model=deepseek \
        --log-dir evals/logs          # scenarios with known answers (evals/scenarios/)
    uv run inspect view --log-dir evals/logs

Task options (`-T name=value`):
- agent_model: `fake` (scripted, free), `deepseek[:model]` (DeepSeek's API)
  or `azure_foundry[:deployment]`; keys come from .env.
- judge_model: same format; keep it fixed across the runs you compare.
  `none` skips the judge.
- dataset: JSONL from `python -m evals.dataset export`.
- web: record | replay | live (see evals/exa_cache.py); web_cache: its file.
- reset_db: recreate helios_eval from the snapshot first (default true).

The run shows in Inspect as model `helios/<agent_model>`. That model is a
label only: our own harness calls the provider, so Inspect's model usage
stays empty and the numbers live in the scores.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
import sys
from pathlib import Path

# `inspect eval` loads this file by path: make `app` and `evals` importable.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from evals.env import CACHE_DIR, HERE, point_at_eval_db

point_at_eval_db()  # before anything imports app.db
# Imported now: Inspect restores sys.path after loading this file, and later
# `from app… import` calls then resolve through the loaded package.
import app.agent.runner  # noqa: F401

SCENARIOS = HERE / "scenarios"

from inspect_ai import Task, task
from inspect_ai.dataset import Sample
from inspect_ai.model import (
    ChatMessage,
    ChatMessageAssistant,
    ChatMessageTool,
    ChatMessageUser,
    ModelAPI,
    ModelOutput,
    modelapi,
)
from inspect_ai.solver import Generate, TaskState, solver
from inspect_ai.tool import ToolCall

from evals import dataset as ds
from evals import replay
from evals.env import assert_eval_db
from evals.exa_cache import ExaCache
from evals.scorers import (
    buyer_overlap,
    filter_retention,
    fit_scoring,
    harness_metrics,
    judge,
    scoring_judge,
)


class AgentLabel(ModelAPI):
    """Names the agent model in Inspect's logs; never called."""

    def __init__(self, model_name, base_url=None, api_key=None, config=None, **_):
        super().__init__(model_name, base_url, api_key, [], config)

    async def generate(self, input, tools, tool_choice, config):
        raise RuntimeError("The Helios harness calls the model, not Inspect.")


@modelapi(name="helios")
def helios_label():
    return AgentLabel


def configure_agent(spec: str) -> None:
    """Point the harness at the model under test. One model per process:
    it sets the agent settings, so the chats' config versions record it."""
    from app import config
    from app.agent import runner

    if spec == "fake":
        from evals.fake import FakeAgent

        # Settings only label the chats' config version; the fake answers.
        _agent_settings("fake", FakeAgent.model, "http://fake.invalid")
        runner.use_chat_factory(FakeAgent)
        return
    provider, _, model = spec.partition(":")
    if provider not in config.PROVIDER_DEFAULTS:
        raise ValueError(f"Unknown agent provider {provider!r}; use one of "
                         f"{', '.join(config.PROVIDER_DEFAULTS)} or fake.")
    _agent_settings(provider, model)
    _, _, key, _ = config.settings().agent_llm
    if not key:
        raise RuntimeError(f"No API key for {provider}: link the gateway's .env "
                           "into this folder (see evals/README.md).")
    runner.use_chat_factory(None)


def _agent_settings(provider: str, model: str, base_url: str = "") -> None:
    from app import config, llm

    os.environ.update(AGENT_LLM_PROVIDER=provider, AGENT_LLM_MODEL=model,
                      AGENT_LLM_BASE_URL=base_url, AGENT_LLM_API_KEY="")
    config.settings.cache_clear()
    llm.chat_provider.cache_clear()


def transcript(result: replay.Replay) -> list[ChatMessage]:
    """The replayed chat as Inspect messages, for the log viewer."""
    out: list[ChatMessage] = []
    answers = iter(result.answers)
    step_msg: dict[str, ChatMessageAssistant] = {}
    for e in result.events:
        p, t = e["payload"], e["type"]
        if t == "user.message":
            out.append(ChatMessageUser(content=p.get("text") or ""))
        elif t == "user.web_access":
            out.append(ChatMessageUser(
                content=f"[web search {'on' if p.get('enabled') else 'off'}]"))
        elif t == "user.tool_result":
            a = next(answers, None) or {}
            out.append(ChatMessageUser(content=(
                f"[card: {a.get('question', '')}] {p.get('answer')}"
                f"  ({a.get('source', '?')} answer)")))
        elif t in ("agent.message", "agent.tool_use"):
            msg = step_msg.get(p.get("step") or "")
            if msg is None:
                msg = ChatMessageAssistant(content="", tool_calls=[])
                step_msg[p.get("step") or ""] = msg
                out.append(msg)
            if t == "agent.message":
                msg.content = p.get("text") or ""
            else:
                msg.tool_calls.append(ToolCall(id=p["tool_call_id"], function=p["name"],
                                               arguments=p.get("arguments") or {}))
        elif t == "agent.tool_result":
            out.append(ChatMessageTool(
                content=(p.get("content") or "")[:20_000], tool_call_id=p["tool_call_id"],
                function=p.get("name")))
        elif t == "session.error":
            out.append(ChatMessageAssistant(content=f"[error] {p.get('message')}"))
    return out


@solver
def replay_chat():
    """Run the sample's chat through the real harness (in a worker thread:
    the harness is synchronous)."""

    async def solve(state: TaskState, generate: Generate) -> TaskState:
        result = await asyncio.to_thread(replay.run, state.metadata["sample"])
        state.store.set("helios", result.to_dict())
        state.messages = transcript(result)
        final = next((e["payload"].get("text") for e in reversed(result.events)
                      if e["type"] == "agent.message" and e["payload"].get("text")), "")
        state.output = ModelOutput.from_content(str(state.model), final or "")
        return state

    return solve


@task
def helios_replay(
    agent_model: str = "fake",
    judge_model: str = "deepseek",
    dataset: str = str(ds.DEFAULT_OUT),
    web: str = "record",
    web_cache: str = str(CACHE_DIR / "exa.json"),
    reset_db: bool = True,
) -> Task:
    _prepare(agent_model, reset_db, web, web_cache)
    scorers = [harness_metrics(), buyer_overlap()]
    if judge_model != "none":
        scorers.append(judge(judge_model))
    return Task(
        name="helios_replay", dataset=_samples(dataset), solver=replay_chat(),
        scorer=scorers, model=f"helios/{agent_model}",
        metadata=run_metadata(agent_model, judge_model, web, dataset))


@task
def helios_scenarios(
    agent_model: str = "fake",
    judge_model: str = "deepseek",
    dataset: str = str(SCENARIOS),
    web: str = "replay",
    web_cache: str = str(CACHE_DIR / "exa.json"),
    reset_db: bool = True,
) -> Task:
    """Hand-written scenarios with a known right answer (`dataset`: a JSONL
    file or a folder of them, default all of evals/scenarios/). Each starts
    the chat on a seeded list of fictional companies. Scorers apply by the
    sample's `behaviour`: `missing_data_on_filter` (filters.jsonl: keep and
    flag rows whose deciding value is unknown) and `fit_scoring`
    (scoring.jsonl: fit scores and rationales per Helbling's criteria, plus
    the scoring judge unless judge_model is none)."""
    _prepare(agent_model, reset_db, web, web_cache)
    scorers = [filter_retention(), fit_scoring()]
    if judge_model != "none":
        scorers.append(scoring_judge(judge_model))
    return Task(
        name="helios_scenarios", dataset=_samples(dataset), solver=replay_chat(),
        scorer=[*scorers, harness_metrics()], model=f"helios/{agent_model}",
        metadata=run_metadata(agent_model, judge_model, web, dataset))


def _digest(*paths: Path) -> str:
    h = hashlib.sha256()
    for path in paths:
        h.update(path.read_bytes() if path.is_file() else b"")
    return h.hexdigest()[:10]


def run_metadata(agent_model: str, judge_model: str, web: str, dataset: str) -> dict:
    """What a run tested, for `python -m evals.history`: the models, a hash of
    the agent's setup (prompt, skills, tools, model: its config version's
    content hash), of the judge's rubrics and of the dataset, so a score
    change can be tied to what changed."""
    from app.agent import config as agent_config

    p = Path(dataset)
    files = sorted(p.glob("*.jsonl")) if p.is_dir() else [p]
    return {"agent_model": agent_model, "judge_model": judge_model, "web": web,
            "agent_config": agent_config.content_hash(agent_config.spec())[:10],
            "rubric": _digest(HERE / "rubric.md", HERE / "rubric_scoring.md"),
            "dataset": p.name, "dataset_hash": _digest(*files)}


def _prepare(agent_model: str, reset_db: bool, web: str, web_cache: str) -> None:
    from app.agent import runner

    configure_agent(agent_model)
    if reset_db:
        from evals import db

        db.reset()
    assert_eval_db()
    cache = ExaCache(Path(web_cache), web)  # type: ignore[arg-type]
    runner.use_exa_search(cache.search)


def _samples(path: str) -> list[Sample]:
    p = Path(path)
    files = sorted(p.glob("*.jsonl")) if p.is_dir() else [p]
    return [Sample(id=x["id"], input=x["input"],
                   metadata={"title": x.get("title"), "sample": x})
            for f in files for x in ds.load(f)]
