"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  createSession,
  deleteSession,
  getSession,
  interruptSession,
  listSessions,
  patchSession,
  postMessage,
  postToolResult,
  getEvents,
  streamSession,
  type PendingAsk,
  type StreamMessage,
  type SessionEvent,
  type SessionSummary,
} from "./sessions";
import {
  collapseSteps,
  eventTime,
  finishedLabel,
  runningLabel,
  type WorkBlock,
  type WorkStep,
} from "./workLog";

export type Attachment = { name: string; size: number };

export const isSpreadsheet = (file: Attachment) =>
  /\.(xlsx|xls|csv)$/i.test(file.name);

/** A rendered chat bubble derived from the session event log. */
export type Message = {
  id: string;
  kind?: "message";
  role: "user" | "assistant";
  content: string;
  status: "streaming" | "done";
  /** Stopped by the user before it finished. */
  stopped?: boolean;
  /** A spreadsheet the user imported into a list from this chat. */
  file?: {
    name: string;
    listName: string | null;
    newRows: number;
    changed: number;
  };
};

export type ThreadItem = Message | WorkBlock;

export type Conversation = {
  id: string;
  title: string;
  pinned?: boolean;
  messages: ThreadItem[];
  busy: boolean;
  hasList: boolean;
  listIds: string[];
  pendingAsk: PendingAsk | null;
  /** Live text while the model streams (not yet an agent.message event). */
  streamingText: string;
  stopReason: SessionSummary["stop_reason"];
};

type ChatContextValue = {
  conversations: Conversation[];
  ready: boolean;
  getConversation: (id: string) => Conversation | undefined;
  ensureConversation: (id: string) => Promise<Conversation | null>;
  startConversation: (text: string) => Promise<string>;
  sendMessage: (conversationId: string, text: string) => Promise<void>;
  answerQuestion: (conversationId: string, answer: string) => Promise<void>;
  dismissQuestions: (conversationId: string) => void;
  stopGenerating: (conversationId: string) => Promise<void>;
  /** Back home: stop streaming the chat that was open. */
  leaveConversation: () => void;
};

type ChatActionsValue = {
  renameConversation: (id: string, title: string) => void;
  deleteConversation: (id: string) => void;
  togglePinConversation: (id: string) => void;
};

const ChatContext = createContext<ChatContextValue | null>(null);
const ChatActionsContext = createContext<ChatActionsValue | null>(null);

export type ConversationMeta = {
  id: string;
  title: string;
  pinned?: boolean;
  busy: boolean;
  hasList: boolean;
};
const ChatListContext = createContext<ConversationMeta[]>([]);

function eventsToMessages(
  events: SessionEvent[],
  streamingText: string,
  busy: boolean,
): ThreadItem[] {
  const out: ThreadItem[] = [];
  // Holder so nested helpers can reassign without TS control-flow wiping the type.
  const run: { work: WorkBlock | null } = { work: null };
  const pending = new Map<string, WorkStep>();

  const closeWork = (at: number, stopped = false, failed = false) => {
    if (!run.work) return;
    for (const step of pending.values()) {
      if (step.status === "running") step.status = stopped ? "error" : "done";
    }
    pending.clear();
    run.work.steps = collapseSteps(run.work.steps);
    run.work.status = "done";
    run.work.finishedAt = at;
    run.work.stopped = stopped && !failed;
    run.work.failed = failed;
    run.work = null;
  };

  const moveWorkToEnd = () => {
    if (!run.work) return;
    const i = out.indexOf(run.work);
    if (i >= 0 && i !== out.length - 1) {
      out.splice(i, 1);
      out.push(run.work);
    }
  };

  const ensureWork = (e: SessionEvent) => {
    if (!run.work) {
      run.work = {
        id: `work-${e.seq}`,
        kind: "work",
        steps: [],
        status: "streaming",
        startedAt: eventTime(e),
      };
      out.push(run.work);
    } else {
      moveWorkToEnd();
    }
    return run.work;
  };

  for (const e of events) {
    if (e.type === "user.message") {
      closeWork(eventTime(e), false);
      out.push({
        id: `e${e.seq}`,
        role: "user",
        content: String(e.payload.text ?? ""),
        status: "done",
      });
    } else if (e.type === "user.import") {
      out.push({
        id: `e${e.seq}`,
        role: "user",
        content: "",
        status: "done",
        file: {
          name: String(e.payload.filename ?? ""),
          listName: (e.payload.list_name as string) ?? null,
          newRows: Number(e.payload.new_rows ?? 0),
          changed: Number(e.payload.changed_cells ?? 0),
        },
      });
    } else if (e.type === "user.tool_result") {
      closeWork(eventTime(e), false);
      out.push({
        id: `e${e.seq}`,
        role: "user",
        content: String(e.payload.answer ?? ""),
        status: "done",
      });
    } else if (e.type === "agent.message") {
      out.push({
        id: `e${e.seq}`,
        role: "assistant",
        content: String(e.payload.text ?? ""),
        status: "done",
      });
      // Keep the open work log under the latest prose of this run.
      moveWorkToEnd();
    } else if (e.type === "agent.tool_use") {
      const name = String(e.payload.name ?? "");
      const args = (e.payload.arguments as Record<string, unknown>) ?? {};
      const start = runningLabel(name, args);
      if (!start) continue;
      const block = ensureWork(e);
      const id = String(e.payload.tool_call_id ?? `use-${e.seq}`);
      const step: WorkStep = {
        id,
        tool: name,
        mergeKey: start.mergeKey,
        label: start.label,
        status: "running",
      };
      block.steps.push(step);
      pending.set(id, step);
    } else if (e.type === "agent.tool_result") {
      const name = String(e.payload.name ?? "");
      const id = String(e.payload.tool_call_id ?? "");
      const use = events
        .slice()
        .reverse()
        .find(
          (x) =>
            x.type === "agent.tool_use" &&
            String(x.payload.tool_call_id ?? "") === id,
        );
      const args =
        (use?.payload.arguments as Record<string, unknown> | undefined) ?? {};
      const done = finishedLabel(name, args, e.payload.content);
      if (!done) {
        pending.delete(id);
        continue;
      }
      const block = ensureWork(e);
      const existing = pending.get(id);
      if (existing) {
        existing.label = done.label;
        existing.mergeKey = done.mergeKey;
        existing.status = done.error ? "error" : "done";
        pending.delete(id);
      } else {
        block.steps.push({
          id: id || `result-${e.seq}`,
          tool: name,
          mergeKey: done.mergeKey,
          label: done.label,
          status: done.error ? "error" : "done",
        });
      }
    } else if (e.type === "session.status_idle") {
      const reason = String(e.payload.stop_reason ?? "");
      closeWork(
        eventTime(e),
        reason === "interrupted" || reason === "error",
        reason === "error",
      );
    } else if (e.type === "session.error") {
      closeWork(eventTime(e), true, true);
      out.push({
        id: `e${e.seq}`,
        role: "assistant",
        content: String(e.payload.message ?? "Something went wrong."),
        status: "done",
        stopped: true,
      });
    }
  }

  if (streamingText) {
    out.push({
      id: "streaming",
      role: "assistant",
      content: streamingText,
      status: "streaming",
    });
  } else if (busy && !run.work) {
    // WorkLog already shows the thinking grid while a run is open.
    out.push({
      id: "thinking",
      role: "assistant",
      content: "",
      status: "streaming",
    });
  }
  return out;
}

function toConversation(
  summary: SessionSummary,
  events: SessionEvent[] = [],
  pendingAsk: PendingAsk | null = null,
  streamingText = "",
): Conversation {
  const busy = summary.status === "running" || summary.busy;
  return {
    id: summary.id,
    title: summary.title,
    pinned: summary.pinned,
    messages: eventsToMessages(events, streamingText, busy),
    busy,
    hasList: summary.has_list || (summary.list_ids?.length ?? 0) > 0,
    listIds: summary.list_ids ?? [],
    pendingAsk: summary.stop_reason === "requires_action" ? pendingAsk : null,
    streamingText,
    stopReason: summary.stop_reason,
  };
}

// Not from the gateway: clears half-streamed text after a reconnect, since
// deltas sent while the stream was down are gone (the stored message follows).
const STREAM_RESET = "stream.reset";

function applyEvent(
  c: Conversation,
  msg: StreamMessage,
  events: SessionEvent[],
): { conversation: Conversation; events: SessionEvent[] } {
  const payload = msg.payload ?? {};
  if (msg.type === STREAM_RESET) {
    return {
      conversation: {
        ...c,
        streamingText: "",
        messages: eventsToMessages(events, "", c.busy),
      },
      events,
    };
  }
  if (msg.type === "agent.message_delta") {
    return {
      conversation: {
        ...c,
        streamingText: c.streamingText + String(payload.text ?? ""),
        busy: true,
        messages: eventsToMessages(
          events,
          c.streamingText + String(payload.text ?? ""),
          true,
        ),
      },
      events,
    };
  }

  let nextEvents = events;
  if (msg.seq != null) {
    if (!events.some((e) => e.seq === msg.seq)) {
      nextEvents = [
        ...events,
        {
          seq: msg.seq,
          type: msg.type,
          payload,
          processed_at: null,
          created_at: msg.created_at ?? new Date().toISOString(),
        },
      ].sort((a, b) => a.seq - b.seq);
    }
  }

  let pendingAsk = c.pendingAsk;
  let busy = c.busy;
  let stopReason = c.stopReason;
  let listIds = c.listIds;
  const title = c.title;
  let streamingText = c.streamingText;

  if (msg.type === "session.status_running") {
    busy = true;
    streamingText = "";
  } else if (msg.type === "session.status_idle") {
    busy = false;
    streamingText = "";
    stopReason = (payload.stop_reason as Conversation["stopReason"]) ?? null;
    if (stopReason === "requires_action" && payload.tool_call_id) {
      pendingAsk = {
        tool_call_id: String(payload.tool_call_id),
        question: String(payload.question ?? ""),
        options: (payload.options as string[]) ?? [],
        grant: (payload.grant as string) ?? null,
        kind: (payload.kind as string) ?? null,
        scope: (payload.scope as string) ?? null,
        query: (payload.query as string) ?? null,
      };
    } else {
      pendingAsk = null;
    }
  } else if (msg.type === "agent.message") {
    streamingText = "";
  } else if (msg.type === "user.import") {
    const id = payload.list_id as string | undefined;
    if (id && !listIds.includes(id)) listIds = [...listIds, id];
  } else if (msg.type === "agent.tool_result") {
    // List tools attach list_id in content JSON.
    try {
      const content = JSON.parse(String(payload.content ?? "{}")) as {
        list_id?: string;
      };
      if (content.list_id && !listIds.includes(content.list_id)) {
        listIds = [...listIds, content.list_id];
      }
    } catch {
      /* ignore */
    }
  }

  const summaryLike: SessionSummary = {
    id: c.id,
    title,
    pinned: !!c.pinned,
    status: busy ? "running" : "idle",
    stop_reason: stopReason,
    list_ids: listIds,
    web_research_enabled: false,
    pending_tool_call_id: pendingAsk?.tool_call_id ?? null,
    agent_config_version: 1,
    created_at: null,
    updated_at: null,
    busy,
    has_list: listIds.length > 0,
  };

  return {
    conversation: {
      ...toConversation(summaryLike, nextEvents, pendingAsk, streamingText),
      title,
    },
    events: nextEvents,
  };
}

/** Folds a sessions listing into the chats we have: new ones are added,
 * known ones get their sidebar fields (the open chat's stream is fresher, so
 * `live` is left alone). Chats not listed yet (just created) are kept. */
function mergeSummaries(
  prev: Conversation[],
  rows: SessionSummary[],
  live: string | null,
): Conversation[] {
  const byId = new Map(prev.map((c) => [c.id, c]));
  const listed = rows.map((r) => {
    const cur = byId.get(r.id);
    if (!cur) return toConversation(r);
    if (r.id === live) return cur;
    return {
      ...cur,
      title: r.title,
      pinned: r.pinned,
      busy: r.status === "running",
      hasList: r.list_ids.length > 0,
      listIds: r.list_ids,
      stopReason: r.stop_reason,
    };
  });
  const ids = new Set(rows.map((r) => r.id));
  return [...prev.filter((c) => !ids.has(c.id)), ...listed];
}

const RECONNECT_MAX_MS = 10_000;
const SIDEBAR_POLL_MS = 4_000;

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [ready, setReady] = useState(false);
  const eventsRef = useRef(new Map<string, SessionEvent[]>());
  // One live stream: the chat on screen. Others refresh from the listing.
  const streamRef = useRef<{ id: string; stop: () => void } | null>(null);
  const [liveId, setLiveId] = useState<string | null>(null);

  const upsert = useCallback((c: Conversation) => {
    setConversations((prev) => {
      const i = prev.findIndex((x) => x.id === c.id);
      if (i < 0) return [c, ...prev];
      const next = [...prev];
      next[i] = c;
      return next;
    });
  }, []);

  const apply = useCallback((id: string, msg: StreamMessage) => {
    setConversations((prev) => {
      const cur = prev.find((c) => c.id === id);
      if (!cur) return prev;
      const { conversation, events } = applyEvent(
        cur,
        msg,
        eventsRef.current.get(id) ?? [],
      );
      eventsRef.current.set(id, events);
      return prev.map((c) => (c.id === id ? conversation : c));
    });
  }, []);

  const unwatch = useCallback(() => {
    streamRef.current?.stop();
    streamRef.current = null;
    setLiveId(null);
  }, []);

  /** Stream this chat live (closing any other). If the stream drops, catch
   * up on the stored events it missed, then reopen it, backing off. */
  const watch = useCallback(
    (id: string) => {
      if (streamRef.current?.id === id) return;
      streamRef.current?.stop();
      const lastSeq = () => eventsRef.current.get(id)?.at(-1)?.seq ?? 0;
      let stopped = false;
      let attempt = 0;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let close: (() => void) | undefined;
      const open = () => {
        close = streamSession(id, lastSeq(), {
          onEvent: (msg) => {
            attempt = 0;
            apply(id, msg);
          },
          onClose: () => {
            if (stopped) return;
            const wait = Math.min(RECONNECT_MAX_MS, 1000 * 2 ** attempt++);
            timer = setTimeout(reconnect, wait);
          },
        });
      };
      const reconnect = async () => {
        if (stopped) return;
        try {
          const { events } = await getEvents(id, lastSeq());
          apply(id, { type: STREAM_RESET });
          for (const e of events) apply(id, e);
        } catch {
          /* still down: open() fails too and backs off again */
        }
        if (!stopped) open();
      };
      open();
      streamRef.current = {
        id,
        stop: () => {
          stopped = true;
          clearTimeout(timer);
          close?.();
        },
      };
      setLiveId(id);
    },
    [apply],
  );

  useEffect(() => {
    let live = true;
    listSessions()
      .then((rows) => {
        if (!live) return;
        // Merged, so a chat opened by URL meanwhile keeps its messages.
        setConversations((prev) => mergeSummaries(prev, rows, null));
        setReady(true);
      })
      .catch(() => live && setReady(true));
    return () => {
      live = false;
      streamRef.current?.stop();
      streamRef.current = null;
    };
  }, []);

  // Busy chats other than the open one: refresh the sidebar from the
  // listing (titles and status only) until they finish.
  const busyElsewhere = conversations
    .filter((c) => c.busy && c.id !== liveId)
    .map((c) => c.id)
    .join(",");
  useEffect(() => {
    if (!busyElsewhere) return;
    const timer = setInterval(() => {
      listSessions().then(
        (rows) =>
          setConversations((prev) => mergeSummaries(prev, rows, liveId)),
        () => {},
      );
    }, SIDEBAR_POLL_MS);
    return () => clearInterval(timer);
  }, [busyElsewhere, liveId]);

  /** Load a chat fresh (its events may be stale if it wasn't on screen)
   * and stream it. Null if it doesn't exist or isn't ours. */
  const ensureConversation = useCallback(
    async (id: string): Promise<Conversation | null> => {
      try {
        const detail = await getSession(id);
        const c = toConversation(detail, detail.events, detail.pending_ask, "");
        eventsRef.current.set(id, detail.events);
        upsert(c);
        watch(id); // no-op if it is already live
        return c;
      } catch {
        return null;
      }
    },
    [upsert, watch],
  );

  const startConversation = useCallback(
    async (text: string) => {
      const detail = await createSession(text);
      const c = toConversation(detail, detail.events, detail.pending_ask, "");
      eventsRef.current.set(detail.id, detail.events);
      upsert(c);
      watch(detail.id);
      return detail.id;
    },
    [upsert, watch],
  );

  /** Show a just-posted user event and the session's new status. */
  const posted = useCallback(
    (id: string, event: SessionEvent, session: SessionSummary) => {
      const prev = eventsRef.current.get(id) ?? [];
      const events = prev.some((e) => e.seq === event.seq)
        ? prev
        : [...prev, event].sort((a, b) => a.seq - b.seq);
      eventsRef.current.set(id, events);
      upsert(toConversation(session, events, null, ""));
      watch(id);
    },
    [upsert, watch],
  );

  const sendMessage = useCallback(
    async (conversationId: string, text: string) => {
      const { event, session } = await postMessage(conversationId, text);
      posted(conversationId, event, session);
    },
    [posted],
  );

  const answerQuestion = useCallback(
    async (conversationId: string, answer: string) => {
      const ask = conversations.find(
        (x) => x.id === conversationId,
      )?.pendingAsk;
      const { event, session } = ask
        ? await postToolResult(conversationId, ask.tool_call_id, answer)
        : await postMessage(conversationId, answer);
      posted(conversationId, event, session);
    },
    [conversations, posted],
  );

  const dismissQuestions = useCallback((conversationId: string) => {
    setConversations((prev) =>
      prev.map((c) =>
        c.id === conversationId ? { ...c, pendingAsk: null } : c,
      ),
    );
  }, []);

  const stopGenerating = useCallback(
    async (conversationId: string) => {
      try {
        const { event } = await interruptSession(conversationId);
        apply(conversationId, event);
      } catch {
        /* the stream shows whatever happened */
      }
    },
    [apply],
  );

  const leaveConversation = unwatch;

  const getConversation = useCallback(
    (id: string) => conversations.find((c) => c.id === id),
    [conversations],
  );

  const renameConversation = useCallback((id: string, title: string) => {
    const next = title.trim();
    if (!next) return;
    setConversations((prev) =>
      prev.map((c) => (c.id === id ? { ...c, title: next } : c)),
    );
    patchSession(id, { title: next }).catch(() => {});
  }, []);

  const deleteConversation = useCallback((id: string) => {
    if (streamRef.current?.id === id) {
      streamRef.current.stop();
      streamRef.current = null;
      setLiveId(null);
    }
    eventsRef.current.delete(id);
    setConversations((prev) => prev.filter((c) => c.id !== id));
    deleteSession(id).catch(() => {});
  }, []);

  const togglePinConversation = useCallback((id: string) => {
    setConversations((prev) => {
      const cur = prev.find((c) => c.id === id);
      if (!cur) return prev;
      const pinned = !cur.pinned;
      patchSession(id, { pinned }).catch(() => {});
      return prev.map((c) => (c.id === id ? { ...c, pinned } : c));
    });
  }, []);

  const actions = useMemo(
    () => ({ renameConversation, deleteConversation, togglePinConversation }),
    [renameConversation, deleteConversation, togglePinConversation],
  );

  const metaKey = conversations
    .map(
      (c) =>
        `${c.id}\u0000${c.title}\u0000${c.pinned ? 1 : 0}${c.busy ? 1 : 0}${c.hasList ? 1 : 0}`,
    )
    .join("\u0001");
  const meta = useMemo(
    () =>
      conversations.map((c) => ({
        id: c.id,
        title: c.title,
        pinned: c.pinned,
        busy: c.busy,
        hasList: c.hasList,
      })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [metaKey],
  );

  return (
    <ChatContext.Provider
      value={{
        conversations,
        ready,
        getConversation,
        ensureConversation,
        startConversation,
        sendMessage,
        answerQuestion,
        dismissQuestions,
        stopGenerating,
        leaveConversation,
      }}
    >
      <ChatActionsContext.Provider value={actions}>
        <ChatListContext.Provider value={meta}>
          {children}
        </ChatListContext.Provider>
      </ChatActionsContext.Provider>
    </ChatContext.Provider>
  );
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used inside <ChatProvider>");
  return ctx;
}

export function useChatActions() {
  const ctx = useContext(ChatActionsContext);
  if (!ctx)
    throw new Error("useChatActions must be used inside <ChatProvider>");
  return ctx;
}

export function useChatList() {
  return useContext(ChatListContext);
}
