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
  REFINE_DURATION_MS,
  RESEARCH_DURATION_MS,
  refineSummary,
} from "./research";
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
  kind?: "text" | "research" | "intake" | "refine";
  /** 0..1 while an intake message works through its steps. */
  progress?: number;
  startedAt?: number;
  finishedAt?: number;
  /** Stopped by the user before it finished. */
  stopped?: boolean;
};

export type Research = {
  startedAt: number;
  /** 0..1, drives the steps, row count and table fill. */
  progress: number;
  done: boolean;
  /** The third exchange's pass: Europe only plus the Sauvignon column. */
  refine?: Refine;
};

export type Refine = {
  startedAt: number;
  progress: number;
  done: boolean;
  /** The new column keeps a blue border until the next agent reply. */
  highlight: boolean;
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
  stopGenerating: (conversationId: string) => void;
};

const ChatContext = createContext<ChatContextValue | null>(null);

// Titles only, so the sidebar doesn't re-render on every streamed token.
type ConversationMeta = Pick<Conversation, "id" | "title">;
const ChatListContext = createContext<ConversationMeta[]>([]);

type Timer = ReturnType<typeof setTimeout>;

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

/** "Consilio: Founded in 1997, …" names the company being sold. */
export function companyFromMessage(text: string) {
  const label = text.match(/^\s*([^:\n]{2,40}):/)?.[1].trim();
  return label && label.split(/\s+/).length <= 4 ? label : undefined;
}

export function titleFromMessage(text: string) {
  // A company to sell: title the chat after the longlist built for it.
  const company = companyFromMessage(text);
  if (company) return `${company} Buyer Longlist`;
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

export function refineSummaryText() {
  const { strategic, financial } = refineSummary();
  const n = (x: number) => x.toLocaleString("en-US");
  return [
    "I've narrowed both lists to buyers headquartered in Europe and added an Owner likes Sauvignon column (Yes/No) to each, highlighted in blue.",
    `- Europe only: removed ${n(strategic.removed)} strategic and ${n(financial.removed)} financial buyers, mostly US IT service groups and funds. The lists now hold ${n(strategic.total)} and ${n(financial.total)} buyers.\n- Owner likes Sauvignon: a confirmed yes adds 2 points to the fit score, a no takes 20 off. Every rationale now says what we found.\n- Most owners leave no public trace of their taste in wine, so about half the answers are Unknown. Those cells are marked grey and don't change the score.\n- BWK stays on top: its owner likes Sauvignon Blanc, which lifts its fit to 96.`,
    "Both lists are now at Version 5. Want me to draft a discreet question for the next owner calls?",
  ].join("\n\n");
}

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
  // Running timers per conversation, so Stop can cancel that one's work.
  // The title stream has its own key and isn't stopped.
  const timers = useRef(new Map<string, Set<Timer>>());
  const track = useCallback((key: string, timer: Timer) => {
    const set = timers.current.get(key) ?? new Set();
    set.add(timer);
    timers.current.set(key, set);
  }, []);
  const untrack = useCallback((key: string, timer: Timer) => {
    timers.current.get(key)?.delete(timer);
  }, []);
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
        untrack(`title:${conversationId}`, start);
        const tick = setInterval(() => {
          i += 1;
          patchConversation(conversationId, () => ({
            title: title.slice(0, i),
          }));
          if (i >= title.length) {
            clearInterval(tick);
            untrack(`title:${conversationId}`, tick);
          }
        }, 35);
        track(`title:${conversationId}`, tick);
      }, 700);
      track(`title:${conversationId}`, start);
    },
    [patchConversation, track, untrack],
  );

  // Fake "model": wait a moment, then stream the canned answer word by word.
  const respond = useCallback(
    (conversationId: string, messageId: string, answer: string) => {
      const tokens = answer.split(/(\s+)/);
      let i = 0;
      const start = setTimeout(() => {
        untrack(conversationId, start);
        const tick = setInterval(() => {
          i += 2;
          const done = i >= tokens.length;
          patchMessage(conversationId, messageId, {
            content: tokens.slice(0, i).join(""),
            status: done ? "done" : "streaming",
          });
          if (done) {
            clearInterval(tick);
            untrack(conversationId, tick);
          }
        }, 28);
        track(conversationId, tick);
      }, 2200);
      track(conversationId, start);
    },
    [patchMessage, track, untrack],
  );

  // Fake research run: a short think, then progress ticks from 0 to 1 over
  // RESEARCH_DURATION_MS while the table fills, then the summary lands.
  const runResearch = useCallback(
    (conversationId: string, messageId: string) => {
      const start = setTimeout(() => {
        untrack(conversationId, start);
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
            untrack(conversationId, tick);
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
        track(conversationId, tick);
      }, 1200);
      track(conversationId, start);
    },
    [patchConversation, patchMessage, track, untrack],
  );

  // Fake intake: work through the profiling steps, show the buyer profiles,
  // then hand over to the question card (its answer starts the research).
  const runIntake = useCallback(
    (conversationId: string, messageId: string) => {
      const start = setTimeout(() => {
        untrack(conversationId, start);
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
            untrack(conversationId, tick);
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
        track(conversationId, tick);
      }, 1000);
      track(conversationId, start);
    },
    [patchConversation, patchMessage, track, untrack],
  );

  // The scope change: drop non-European buyers, add the Sauvignon column and
  // rescore, while the table shows each stage; the lists become Version 5.
  const runRefine = useCallback(
    (conversationId: string, messageId: string) => {
      const start = setTimeout(() => {
        untrack(conversationId, start);
        const startedAt = Date.now();
        patchMessage(conversationId, messageId, {
          status: "researching",
          startedAt,
        });
        const tick = setInterval(() => {
          const progress = Math.min(
            1,
            (Date.now() - startedAt) / REFINE_DURATION_MS,
          );
          const done = progress >= 1;
          patchConversation(conversationId, (c) =>
            c.research
              ? {
                  research: {
                    ...c.research,
                    refine: { startedAt, progress, done, highlight: true },
                  },
                }
              : {},
          );
          if (done) {
            clearInterval(tick);
            untrack(conversationId, tick);
            patchMessage(conversationId, messageId, {
              status: "done",
              finishedAt: Date.now(),
              content: refineSummaryText(),
            });
          }
        }, 120);
        track(conversationId, tick);
      }, 1000);
      track(conversationId, start);
    },
    [patchConversation, patchMessage, track, untrack],
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

  // Cancels whatever the conversation is generating and keeps what's there:
  // partial text, the steps so far, and the rows the table had loaded.
  const stopGenerating = useCallback(
    (conversationId: string) => {
      const set = timers.current.get(conversationId);
      // setTimeout and setInterval ids share one pool, so either clear works.
      set?.forEach((t) => clearInterval(t));
      set?.clear();
      const now = Date.now();
      patchConversation(conversationId, (c) => ({
        messages: c.messages.map((m) =>
          m.status === "done"
            ? m
            : {
                ...m,
                status: "done",
                stopped: true,
                finishedAt: m.startedAt ? now : undefined,
              },
        ),
        // The question card only follows a finished profile.
        scoping:
          c.scoping?.status === "pending"
            ? { ...c.scoping, status: "dismissed" }
            : c.scoping,
        // A stopped refine pass is undone, so the next message can rerun it.
        research:
          c.research && !c.research.done
            ? { ...c.research, done: true }
            : c.research?.refine && !c.research.refine.done
              ? { ...c.research, refine: undefined }
              : c.research,
      }));
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
      // The first message after the lists are built is the scope change.
      const isRefine = !!previous?.research?.done && !previous.research.refine;

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
        kind: isIntake ? "intake" : isRefine ? "refine" : "text",
      };
      patchConversation(conversationId, (c) => ({
        messages: [...c.messages, userMsg, aiMsg],
        ...(isIntake && { scoping: { status: "pending", answers: [] } }),
        // Any later reply is the next pass: the new column's border goes.
        ...(c.research?.refine?.highlight && {
          research: {
            ...c.research,
            refine: { ...c.research.refine, highlight: false },
          },
        }),
      }));

      if (isIntake) runIntake(conversationId, aiMsg.id);
      else if (isRefine) runRefine(conversationId, aiMsg.id);
      else respond(conversationId, aiMsg.id, fakeAnswer(text));
    },
    [patchConversation, respond, runIntake, runRefine, startResearch],
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
        stopGenerating,
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
