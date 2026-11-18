/** Human-readable work-log lines from agent.tool_use / agent.tool_result. */

export type WorkStep = {
  id: string;
  tool: string;
  /** Stable key for collapsing consecutive same-tool steps. */
  mergeKey: string;
  label: string;
  status: "running" | "done" | "error";
  count?: number;
};

export type WorkBlock = {
  id: string;
  kind: "work";
  steps: WorkStep[];
  status: "streaming" | "done";
  startedAt: number;
  finishedAt?: number;
  stopped?: boolean;
  /** Ended by an error (rate limit, provider failure), not by the user. */
  failed?: boolean;
};

type Args = Record<string, unknown>;

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v).trim();
}

function clip(s: string, n = 72): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1).trimEnd()}…`;
}

function parseContent(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "string") return null;
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function quote(q: string): string {
  return q ? ` “${clip(q)}”` : "";
}

export function runningLabel(
  tool: string,
  args: Args,
): {
  label: string;
  mergeKey: string;
} | null {
  if (tool === "ask_user") return null;
  if (tool === "corpus_search") {
    const q = str(args.query);
    return {
      label: `Searching Helios${quote(q)}`,
      mergeKey: "corpus_search",
    };
  }
  if (tool === "web_research") {
    const q = str(args.query);
    return {
      label: `Searching the web${quote(q)}`,
      mergeKey: "web_research",
    };
  }
  if (tool === "request_web_research") {
    const scope = str(args.scope);
    const label =
      scope === "query"
        ? `Asking to search the web${quote(str(args.query))}`
        : scope === "turn"
          ? "Asking to use the web for this turn"
          : "Asking to use the web for this chat";
    return { label, mergeKey: "request_web_research" };
  }
  if (tool === "create_list") {
    const name = str(args.name);
    return {
      label: name ? `Creating “${clip(name)}”` : "Creating a list",
      mergeKey: `create_list:${name}`,
    };
  }
  if (tool === "update_list") {
    return { label: "Updating the list", mergeKey: "update_list" };
  }
  if (tool === "read_list") {
    return { label: "Reading the list", mergeKey: "read_list" };
  }
  return { label: `Running ${tool}`, mergeKey: tool };
}

export function finishedLabel(
  tool: string,
  args: Args,
  contentRaw: unknown,
): { label: string; mergeKey: string; error: boolean } | null {
  if (tool === "ask_user") return null;
  const data = parseContent(contentRaw);
  const err = str(data?.error);
  if (err) {
    const short = err.length > 100 ? `${err.slice(0, 99).trimEnd()}…` : err;
    if (tool === "corpus_search") {
      return {
        label: `Couldn't search Helios${quote(str(args.query))}`,
        mergeKey: "corpus_search",
        error: true,
      };
    }
    if (tool === "web_research") {
      if (/off|request_web_research/i.test(err)) {
        return {
          label: "Web research needs approval",
          mergeKey: "web_research",
          error: true,
        };
      }
      if (/cap reached/i.test(err)) {
        return {
          label: "Web research cap reached",
          mergeKey: "web_research",
          error: true,
        };
      }
      return {
        label: `Web search failed${quote(str(args.query))}`,
        mergeKey: "web_research",
        error: true,
      };
    }
    return {
      label: short,
      mergeKey: tool,
      error: true,
    };
  }

  if (tool === "corpus_search") {
    const total = Number(data?.total ?? 0);
    const q = str(args.query);
    const label =
      total <= 0
        ? `Nothing in Helios${quote(q)}`
        : total === 1
          ? `Found 1 company in Helios${quote(q)}`
          : `Found ${total} companies in Helios${quote(q)}`;
    return { label, mergeKey: "corpus_search", error: false };
  }

  if (tool === "web_research") {
    const results = Array.isArray(data?.results) ? data.results : [];
    const q = str(args.query);
    const n = results.length;
    const label =
      n <= 0
        ? `No web results${quote(q)}`
        : n === 1
          ? `Found 1 web source${quote(q)}`
          : `Found ${n} web sources${quote(q)}`;
    return { label, mergeKey: "web_research", error: false };
  }

  if (tool === "request_web_research") {
    return {
      label: "Waiting for web approval",
      mergeKey: "request_web_research",
      error: false,
    };
  }

  if (tool === "create_list") {
    const name = str(data?.name) || str(args.name);
    const size = data?.size;
    const base = name ? `Created “${clip(name)}”` : "Created a list";
    const label =
      typeof size === "number" && size > 0
        ? `${base} · ${size} ${size === 1 ? "buyer" : "buyers"}`
        : base;
    return {
      label,
      mergeKey: `create_list:${name}`,
      error: false,
    };
  }

  if (tool === "update_list") {
    const changes = data?.changes;
    const version = data?.version;
    let label = "Updated the list";
    if (typeof changes === "number" && changes > 0) {
      label = `Updated the list · ${changes} ${changes === 1 ? "change" : "changes"}`;
    } else if (typeof version === "number") {
      label = `Updated the list · version ${version}`;
    }
    return { label, mergeKey: "update_list", error: false };
  }

  if (tool === "read_list") {
    const name = str(data?.name);
    const size = Number(data?.size ?? 0);
    const label = `Read ${name ? `“${clip(name)}”` : "the list"} · ${size} ${size === 1 ? "buyer" : "buyers"}`;
    return { label, mergeKey: "read_list", error: false };
  }

  return { label: `Finished ${tool}`, mergeKey: tool, error: false };
}

/** Collapse consecutive done steps that share a mergeKey. */
export function collapseSteps(steps: WorkStep[]): WorkStep[] {
  const out: WorkStep[] = [];
  for (const step of steps) {
    const prev = out.at(-1);
    if (
      prev &&
      prev.status === "done" &&
      step.status === "done" &&
      prev.mergeKey === step.mergeKey &&
      !prev.mergeKey.startsWith("create_list:")
    ) {
      const count = (prev.count ?? 1) + (step.count ?? 1);
      out[out.length - 1] = {
        ...prev,
        count,
        label: collapsedLabel(prev.mergeKey, count, step.label),
      };
      continue;
    }
    out.push({ ...step, count: step.count ?? 1 });
  }
  return out;
}

function collapsedLabel(
  mergeKey: string,
  count: number,
  lastLabel: string,
): string {
  if (mergeKey === "corpus_search") {
    return count === 1 ? lastLabel : `Searched Helios ${count}×`;
  }
  if (mergeKey === "web_research") {
    return count === 1 ? lastLabel : `Searched the web ${count}×`;
  }
  if (mergeKey === "update_list") {
    return count === 1 ? lastLabel : `Updated the list ${count}×`;
  }
  return count === 1 ? lastLabel : `${lastLabel} (${count}×)`;
}

export function eventTime(e: {
  created_at?: string | null;
  seq: number;
}): number {
  if (e.created_at) {
    const t = Date.parse(e.created_at);
    if (!Number.isNaN(t)) return t;
  }
  return e.seq;
}
