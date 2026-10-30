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
import { RESEARCH_DURATION_MS } from "./research";

export type Message = {
  id: string;
  role: "user" | "assistant";
  /** Plain text; for research messages it's the copyable summary. */
  content: string;
  status: "thinking" | "researching" | "streaming" | "done";
  kind?: "text" | "research";
  startedAt?: number;
  finishedAt?: number;
};

export type Research = {
  startedAt: number;
  /** 0..1, drives the steps, row count and table fill. */
  progress: number;
  done: boolean;
};

export type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  research?: Research;
};

type ChatContextValue = {
  conversations: Conversation[];
  getConversation: (id: string) => Conversation | undefined;
  startConversation: (text: string) => string;
  sendMessage: (conversationId: string, text: string) => void;
};

const ChatContext = createContext<ChatContextValue | null>(null);

// Titles only, so the sidebar doesn't re-render on every streamed token.
type ConversationMeta = Pick<Conversation, "id" | "title">;
const ChatListContext = createContext<ConversationMeta[]>([]);

const uid = () => Math.random().toString(36).slice(2, 10);

const SMALL_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "for",
  "from",
  "in",
  "of",
  "on",
  "or",
  "the",
  "to",
  "with",
]);

export function titleFromMessage(text: string) {
  const words = text
    .replace(/[^\p{L}\p{N}\s&'-]/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 7);
  const title = words
    .map((w, i) =>
      i > 0 && SMALL_WORDS.has(w.toLowerCase())
        ? w.toLowerCase()
        : w[0].toUpperCase() + w.slice(1),
    )
    .join(" ");
  return title || "New conversation";
}

// First reply scopes the mandate, so the second message can kick off research.
const SCOPING_ANSWER = [
  "Got it. Before I start building the longlist, two quick questions:",
  "1. Should I cover both strategic acquirers and financial sponsors, or only one of them?\n2. Any geographic focus or exclusions — for example the current owner or investors you've already spoken to?",
  'Reply with your preferences (or just say "go") and I\'ll run the search across deal databases, registries and news.',
].join("\n\n");

export const RESEARCH_SUMMARY_TEXT = [
  "I've built two global buyer lists: Strategic buyers with 1,608 companies and Financial buyers with 1,662 investors. Both are screened for sector fit, deal size and recent activity. I left off the current owner and two investors whose matching deals were clearly wrong.",
  "Strategic buyers\n- Large software platforms: Nordwind Software, Helix Systems, Corvane Technologies and Atlas Cloud.\n  - Helix Systems bought Brightline Labs in 2024, a direct precedent.\n- Mid-market consolidators: Kestrel Group, Solano Digital and Quorum Platforms.",
  "Financial buyers\n- Software-focused private equity: Alpine Peak Capital, Lakeview Equity Partners and Granite Growth Partners.\n- Growth equity: Northgate Growth Partners and Ridgeway Capital.",
  "Want me to narrow either list by geography or deal size, or draft outreach for the top 20?",
].join("\n\n");

function fakeAnswer(prompt: string) {
  const topic = prompt.trim().replace(/[?.!]+$/, "");
  return [
    `Here's a first pass on "${topic}". I searched across company registries, deal databases and recent news, then filtered for fit and recency.`,
    `Shortlist\n1. Alpenwerk Holding AG — Zurich, CHF 180M revenue, founder-led, succession question open since 2025.\n2. Nordlicht Systems GmbH — Munich, carve-out candidate after the parent's strategic review in September.\n3. Valtech Ottica S.p.A. — Milan, family-owned, two bolt-on acquisitions in the last 18 months.\n4. Brightmoor Industrial Ltd — Leeds, PE-backed since 2019, typical hold period now exceeded.`,
    `Why these stand out: each shows at least two first-move signals — leadership changes, advisor mandates, or capital structure shifts — that haven't been widely reported yet.`,
    `Want me to turn this into a longlist with contacts, set up a monitor for new signals, or go deeper on one of these companies?`,
  ].join("\n\n");
}

export function ChatProvider({ children }: { children: React.ReactNode }) {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());
  // Mirror for callbacks that need to know how far a conversation has got.
  const conversationsRef = useRef(conversations);
  useEffect(() => {
    conversationsRef.current = conversations;
  }, [conversations]);

  const patchConversation = useCallback(
    (
      conversationId: string,
      patch: (c: Conversation) => Partial<Conversation>,
    ) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, ...patch(c) } : c)),
      );
    },
    [],
  );

  const patchMessage = useCallback(
    (conversationId: string, messageId: string, patch: Partial<Message>) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id !== conversationId
            ? c
            : {
                ...c,
                messages: c.messages.map((m) =>
                  m.id === messageId ? { ...m, ...patch } : m,
                ),
              },
        ),
      );
    },
    [],
  );

  // Fake "model": wait a moment, then stream the canned answer word by word.
  const respond = useCallback(
    (conversationId: string, messageId: string, answer: string) => {
      const tokens = answer.split(/(\s+)/);
      let i = 0;
      const start = setTimeout(() => {
        timers.current.delete(start);
        const tick = setInterval(() => {
          i += 2;
          const done = i >= tokens.length;
          patchMessage(conversationId, messageId, {
            content: tokens.slice(0, i).join(""),
            status: done ? "done" : "streaming",
          });
          if (done) {
            clearInterval(tick);
            timers.current.delete(tick);
          }
        }, 28);
        timers.current.add(tick);
      }, 2200);
      timers.current.add(start);
    },
    [patchMessage],
  );

  // Fake research run: a short think, then progress ticks from 0 to 1 over
  // RESEARCH_DURATION_MS while the table fills, then the summary lands.
  const runResearch = useCallback(
    (conversationId: string, messageId: string) => {
      const start = setTimeout(() => {
        timers.current.delete(start);
        const startedAt = Date.now();
        patchMessage(conversationId, messageId, {
          status: "researching",
          startedAt,
        });
        patchConversation(conversationId, () => ({
          research: { startedAt, progress: 0, done: false },
        }));
        const tick = setInterval(() => {
          const progress = Math.min(
            1,
            (Date.now() - startedAt) / RESEARCH_DURATION_MS,
          );
          patchConversation(conversationId, () => ({
            research: { startedAt, progress, done: progress >= 1 },
          }));
          if (progress >= 1) {
            clearInterval(tick);
            timers.current.delete(tick);
            patchMessage(conversationId, messageId, {
              status: "done",
              finishedAt: Date.now(),
              content: RESEARCH_SUMMARY_TEXT,
            });
          }
        }, 120);
        timers.current.add(tick);
      }, 1200);
      timers.current.add(start);
    },
    [patchConversation, patchMessage],
  );

  const appendExchange = useCallback(
    (conversationId: string, text: string) => {
      const previous = conversationsRef.current.find(
        (c) => c.id === conversationId,
      );
      const turn =
        (previous?.messages.filter((m) => m.role === "user").length ?? 0) + 1;
      const isResearch = turn === 2 && !previous?.research;

      const userMsg: Message = {
        id: uid(),
        role: "user",
        content: text,
        status: "done",
      };
      const aiMsg: Message = {
        id: uid(),
        role: "assistant",
        content: "",
        status: "thinking",
        kind: isResearch ? "research" : "text",
      };
      patchConversation(conversationId, (c) => ({
        messages: [...c.messages, userMsg, aiMsg],
      }));

      if (isResearch) runResearch(conversationId, aiMsg.id);
      else
        respond(
          conversationId,
          aiMsg.id,
          turn === 1 ? SCOPING_ANSWER : fakeAnswer(text),
        );
    },
    [patchConversation, respond, runResearch],
  );

  const startConversation = useCallback(
    (text: string) => {
      const id = uid();
      setConversations((prev) => [
        { id, title: titleFromMessage(text), messages: [] },
        ...prev,
      ]);
      appendExchange(id, text);
      return id;
    },
    [appendExchange],
  );

  const getConversation = useCallback(
    (id: string) => conversations.find((c) => c.id === id),
    [conversations],
  );

  const metaKey = conversations
    .map((c) => `${c.id}\u0000${c.title}`)
    .join("\u0001");
  const meta = useMemo(
    () => conversations.map(({ id, title }) => ({ id, title })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [metaKey],
  );

  return (
    <ChatContext.Provider
      value={{
        conversations,
        getConversation,
        startConversation,
        sendMessage: appendExchange,
      }}
    >
      <ChatListContext.Provider value={meta}>
        {children}
      </ChatListContext.Provider>
    </ChatContext.Provider>
  );
}

export function useChat() {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used inside <ChatProvider>");
  return ctx;
}

export function useChatList() {
  return useContext(ChatListContext);
}
