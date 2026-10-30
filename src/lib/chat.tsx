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
import {
  INTAKE_DURATION_MS,
  INTAKE_TEXT,
  SCOPING_QUESTIONS,
  answersMessage,
  listsPhrase,
} from "./scoping";

export type Message = {
  id: string;
  role: "user" | "assistant";
  /** Plain text; for research messages it's the copyable summary. */
  content: string;
  status: "thinking" | "researching" | "streaming" | "done";
  kind?: "text" | "research" | "intake";
  /** 0..1 while an intake message works through its steps. */
  progress?: number;
  startedAt?: number;
  finishedAt?: number;
};

export type Research = {
  startedAt: number;
  /** 0..1, drives the steps, row count and table fill. */
  progress: number;
  done: boolean;
};

/** The scoping questions asked after the intake profile. */
export type Scoping = {
  /** "pending" until the profile is done; "dismissed" if the user skipped. */
  status: "pending" | "asking" | "dismissed" | "done";
  answers: string[];
};

export type Conversation = {
  id: string;
  title: string;
  messages: Message[];
  scoping?: Scoping;
  research?: Research;
};

type ChatContextValue = {
  conversations: Conversation[];
  getConversation: (id: string) => Conversation | undefined;
  startConversation: (text: string) => string;
  sendMessage: (conversationId: string, text: string) => void;
  answerQuestion: (conversationId: string, answer: string) => void;
  dismissQuestions: (conversationId: string) => void;
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

export const researchSummaryText = (geography?: string) =>
  [
    `I've built ${listsPhrase(geography)}: Strategic buyers with 1,608 companies and Financial buyers with 1,662 investors. Both are screened for sector fit, deal size and recent activity. I left off the current owner and two investors whose matching deals were clearly wrong.`,
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
              content: researchSummaryText(
                conversationsRef.current.find((c) => c.id === conversationId)
                  ?.scoping?.answers[0],
              ),
            });
          }
        }, 120);
        timers.current.add(tick);
      }, 1200);
      timers.current.add(start);
    },
    [patchConversation, patchMessage],
  );

  // Fake intake: work through the profiling steps, show the profile, then
  // hand over to the scoping questions.
  const runIntake = useCallback(
    (conversationId: string, messageId: string) => {
      const start = setTimeout(() => {
        timers.current.delete(start);
        const startedAt = Date.now();
        patchMessage(conversationId, messageId, {
          status: "researching",
          startedAt,
          progress: 0,
        });
        const tick = setInterval(() => {
          const progress = Math.min(
            1,
            (Date.now() - startedAt) / INTAKE_DURATION_MS,
          );
          patchMessage(conversationId, messageId, { progress });
          if (progress >= 1) {
            clearInterval(tick);
            timers.current.delete(tick);
            patchMessage(conversationId, messageId, {
              status: "done",
              finishedAt: Date.now(),
              content: INTAKE_TEXT,
            });
            // Unless the user already moved on by typing.
            patchConversation(conversationId, (c) =>
              c.scoping?.status === "pending"
                ? { scoping: { ...c.scoping, status: "asking" } }
                : {},
            );
          }
        }, 120);
        timers.current.add(tick);
      }, 1000);
      timers.current.add(start);
    },
    [patchConversation, patchMessage],
  );

  // Adds a user message plus an assistant reply that runs as research.
  const startResearch = useCallback(
    (conversationId: string, text: string) => {
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
        kind: "research",
      };
      patchConversation(conversationId, (c) => ({
        messages: [...c.messages, userMsg, aiMsg],
        scoping:
          c.scoping && c.scoping.status !== "done"
            ? { ...c.scoping, status: "dismissed" }
            : c.scoping,
      }));
      runResearch(conversationId, aiMsg.id);
    },
    [patchConversation, runResearch],
  );

  const answerQuestion = useCallback(
    (conversationId: string, answer: string) => {
      const scoping = conversationsRef.current.find(
        (c) => c.id === conversationId,
      )?.scoping;
      if (!scoping || scoping.status !== "asking") return;
      const answers = [...scoping.answers, answer];
      const done = answers.length >= SCOPING_QUESTIONS.length;
      patchConversation(conversationId, () => ({
        scoping: { status: done ? "done" : "asking", answers },
      }));
      // Keep the ref current so a fast second answer sees this one.
      conversationsRef.current = conversationsRef.current.map((c) =>
        c.id === conversationId
          ? { ...c, scoping: { status: done ? "done" : "asking", answers } }
          : c,
      );
      if (done) startResearch(conversationId, answersMessage(answers));
    },
    [patchConversation, startResearch],
  );

  const dismissQuestions = useCallback(
    (conversationId: string) => {
      patchConversation(conversationId, (c) =>
        c.scoping ? { scoping: { ...c.scoping, status: "dismissed" } } : {},
      );
    },
    [patchConversation],
  );

  const appendExchange = useCallback(
    (conversationId: string, text: string) => {
      const previous = conversationsRef.current.find(
        (c) => c.id === conversationId,
      );
      const isIntake = !previous?.messages.length;
      // Without research yet (questions dismissed or skipped by typing),
      // any message starts it.
      if (!isIntake && !previous?.research) {
        startResearch(conversationId, text);
        return;
      }

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
        kind: isIntake ? "intake" : "text",
      };
      patchConversation(conversationId, (c) => ({
        messages: [...c.messages, userMsg, aiMsg],
        ...(isIntake && { scoping: { status: "pending", answers: [] } }),
      }));

      if (isIntake) runIntake(conversationId, aiMsg.id);
      else respond(conversationId, aiMsg.id, fakeAnswer(text));
    },
    [patchConversation, respond, runIntake, startResearch],
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
        answerQuestion,
        dismissQuestions,
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
