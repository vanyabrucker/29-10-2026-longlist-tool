// Real agent chats from helios-gateway (GET/POST /sessions, SSE stream).

import { GatewayError, gw, json } from "./gateway";

export type SessionStatus = "running" | "idle";
export type StopReason =
  "end_turn" | "requires_action" | "interrupted" | "error" | null;

export type SessionEvent = {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  processed_at: string | null;
  created_at: string | null;
};

export type PendingAsk = {
  tool_call_id: string;
  question: string;
  options: string[];
  grant?: string | null;
  kind?: string | null;
  scope?: string | null;
  query?: string | null;
};

export type SessionSummary = {
  id: string;
  title: string;
  pinned: boolean;
  status: SessionStatus;
  stop_reason: StopReason;
  list_ids: string[];
  web_research_enabled: boolean;
  pending_tool_call_id: string | null;
  agent_config_version: number;
  created_at: string | null;
  updated_at: string | null;
  busy: boolean;
  has_list: boolean;
};

export type FeedbackRating = "bad" | "fine" | "good";
/** What the owner said about a chat: null until asked and answered. */
export type FeedbackState = FeedbackRating | "dismissed" | null;

export type SessionDetail = SessionSummary & {
  events: SessionEvent[];
  pending_ask: PendingAsk | null;
  feedback?: FeedbackState;
};

export const listSessions = () => gw<SessionSummary[]>("/sessions");

export const getSession = (id: string) =>
  gw<SessionDetail>(`/sessions/${encodeURIComponent(id)}`);

/** Stored events after `after`, to catch up when a stream dropped. */
export const getEvents = (id: string, after: number) =>
  gw<{ events: SessionEvent[] }>(
    `/sessions/${encodeURIComponent(id)}/events?after=${after}`,
  );

export const createSession = (message: string) =>
  gw<SessionDetail>("/sessions", { method: "POST", ...json({ message }) });

export const patchSession = (
  id: string,
  body: { title?: string; pinned?: boolean },
) =>
  gw<SessionSummary>(`/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    ...json(body),
  });

export const deleteSession = (id: string) =>
  gw<void>(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });

export const postMessage = (id: string, text: string) =>
  gw<{ event: SessionEvent; session: SessionSummary }>(
    `/sessions/${encodeURIComponent(id)}/messages`,
    { method: "POST", ...json({ text }) },
  );

export const postToolResult = (
  id: string,
  tool_call_id: string,
  answer: string,
) =>
  gw<{ event: SessionEvent; session: SessionSummary }>(
    `/sessions/${encodeURIComponent(id)}/tool_results`,
    { method: "POST", ...json({ tool_call_id, answer }) },
  );

/** The header's globe: web search on or off for the whole chat. */
export const setWebAccess = (id: string, enabled: boolean) =>
  gw<{ event: SessionEvent; session: SessionSummary }>(
    `/sessions/${encodeURIComponent(id)}/web_access`,
    { method: "POST", ...json({ enabled }) },
  );

export const interruptSession = (id: string) =>
  gw<{ event: SessionEvent; session: SessionSummary }>(
    `/sessions/${encodeURIComponent(id)}/interrupt`,
    { method: "POST" },
  );

/** A live message: a stored event (with seq) or a text delta (without). */
export type StreamMessage = {
  type: string;
  seq?: number;
  payload?: Record<string, unknown>;
  created_at?: string | null;
};

export type StreamHandlers = {
  onEvent: (msg: StreamMessage) => void;
  /** The stream ended or failed (not when aborted): time to reconnect. */
  onClose?: () => void;
};

/** Subscribe to SSE for a session. Returns an abort function. */
export function streamSession(
  id: string,
  after: number,
  handlers: StreamHandlers,
): () => void {
  const ctrl = new AbortController();
  const url = `/api/gateway/sessions/${encodeURIComponent(id)}/stream?after=${after}`;
  (async () => {
    try {
      const response = await fetch(url, {
        signal: ctrl.signal,
        headers: { Accept: "text/event-stream" },
        cache: "no-store",
      });
      if (!response.ok || !response.body) {
        throw new GatewayError(
          `Stream failed (${response.status})`,
          response.status,
        );
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          for (const line of chunk.split("\n")) {
            if (!line.startsWith("data:")) continue;
            const raw = line.slice(5).trim();
            if (!raw) continue;
            try {
              handlers.onEvent(JSON.parse(raw));
            } catch {
              /* ignore malformed */
            }
          }
        }
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
    }
    if (!ctrl.signal.aborted) handlers.onClose?.();
  })();
  return () => ctrl.abort();
}

/** Rate a chat (Bad / Fine / Good), add a comment after rating, or dismiss
 * the ask (no rating, no comment) so it isn't asked again. */
export const giveFeedback = (
  id: string,
  body: { rating?: FeedbackRating | null; comment?: string },
) =>
  gw<{ id: string; rating: FeedbackRating | null }>(
    `/sessions/${encodeURIComponent(id)}/feedback`,
    { method: "POST", ...json(body) },
  );
