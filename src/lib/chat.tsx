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
  FLOW_QUESTIONS,
  answersMessage,
  geographyFrom,
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
  // "Consilio: Founded in 1997, …" is a company to sell: title it after the
  // longlist being built for it.
  const label = text.match(/^\s*([^:\n]{2,40}):/)?.[1].trim();
  if (label && label.split(/\s+/).length <= 4) return `${label} Buyer Longlist`;
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
    `I've built ${listsPhrase(geography)}: Strategic buyers with 1,608 companies and Financial buyers with 1,662 investors. Strategics are screened for size, sector interest and financing capacity, investors for their published scope, ticket size and stage. Every buyer has a fit score from 0 to 100, and the lists are sorted by it.`,
    "Strategic buyers\n- SAP consultancies: Nordwind Business Consulting and Merkur Digital Consulting.\n  - Nordwind bought Corvane Logistics IT, an SAP supply chain boutique, in 2025, a direct precedent.\n- IT services and supply chain software: Helix IT Services Group and Polaris Supply Chain Solutions.",
    "Financial buyers\n- Mittelstand and succession investors: BWK and Neckar Mittelstand Beteiligungen.\n  - BWK takes majority stakes in established mid-sized companies and has backed engineering service firms.\n- IT services buy-and-build: Isarblick Capital Partners, Rheintal Growth Partners and Kestrel Equity Partners.",
    "Want me to narrow either list, or draft outreach for the top 20?",
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

  const streamTitle = useCallback(
    (conversationId: string, title: string) => {
      let i = 0;
      const start = setTimeout(() => {
        timers.current.delete(start);
        const tick = setInterval(() => {
          i += 1;
          patchConversation(conversationId, () => ({
            title: title.slice(0, i),
          }));
          if (i >= title.length) {
            clearInterval(tick);
            timers.current.delete(tick);
          }
        }, 35);
        timers.current.add(tick);
      }, 700);
      timers.current.add(start);
    },
    [patchConversation],
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
                geographyFrom(
                  conversationsRef.current.find((c) => c.id === conversationId)
                    ?.scoping?.answers,
                ),
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

  // Fake intake: work through the profiling steps, show the buyer profiles,
  // then hand over to the question card (its answer starts the research).
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
      const done = answers.length >= FLOW_QUESTIONS.length;
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
      // Starts untitled; the title streams in shortly after, like a
      // generated one, in the sidebar and the header alike.
      setConversations((prev) => [{ id, title: "", messages: [] }, ...prev]);
      appendExchange(id, text);
      streamTitle(id, titleFromMessage(text));
      return id;
    },
    [appendExchange, streamTitle],
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
