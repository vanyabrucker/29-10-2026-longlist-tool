"use client";

import { AnimatePresence, motion } from "motion/react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  Check,
  ChevronDown,
  Folder,
  MoreHorizontal,
  Search,
  Slash,
} from "react-feather";
import { useChat, type Message, type Research } from "@/lib/chat";
import type { BuyerList } from "@/lib/research";
import { useDismiss } from "@/lib/useDismiss";
import { Composer } from "./Composer";
import { CopyButton } from "./CopyButton";
import { SCOPING_QUESTIONS } from "@/lib/scoping";
import { QuestionCard } from "./QuestionCard";
import { IntakeMessage, ResearchMessage } from "./ResearchMessage";
import { ResearchTable } from "./ResearchTable";
import { ThinkingGrid } from "./ThinkingGrid";

const EASE = [0.32, 0.72, 0, 1] as const;

// Home and chat share one persistent tree, so the composer can glide from the
// hero position down to the bottom instead of the page swapping abruptly.
const NAME = "Vanya";

const TAGLINES = [
  "What’s your next move?",
  "Happy to Helbling",
  "Better than CoPilot",
  "Need a Helbling hand?",
];

function timeGreeting() {
  const h = new Date().getHours();
  const part =
    h >= 5 && h < 12 ? "morning" : h >= 12 && h < 18 ? "afternoon" : "evening";
  return `Good ${part}, ${NAME}`;
}

// Half the time a time-of-day greeting, otherwise one of the taglines.
function pickGreeting() {
  return Math.random() < 0.5
    ? timeGreeting()
    : TAGLINES[Math.floor(Math.random() * TAGLINES.length)];
}

function Greeting() {
  // Chosen once per mount, so it changes each time you come back home.
  const [greeting] = useState(pickGreeting);
  return (
    <h2 className="text-center font-serif text-[2.1rem] leading-tight tracking-[-0.01em]">
      {greeting}
    </h2>
  );
}

export function Workspace() {
  const pathname = usePathname();
  const router = useRouter();
  const {
    getConversation,
    startConversation,
    sendMessage,
    answerQuestion,
    dismissQuestions,
  } = useChat();

  // Switch to chat immediately on submit; don't wait for the route to commit.
  const [pending, setPending] = useState<{ id: string; from: string } | null>(
    null,
  );
  // Once the URL moves on (to the new chat, or back home later), the URL is
  // the source of truth again; otherwise returning to `from` would reopen it.
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setPending(null);
  }
  const routeId = pathname.startsWith("/c/") ? pathname.slice(3) : null;
  const activeId = pending && pending.from === pathname ? pending.id : routeId;
  const conversation = activeId ? getConversation(activeId) : undefined;
  const research = conversation?.research;
  const mode = research ? "research" : conversation ? "chat" : "home";
  const scoping = conversation?.scoping;
  const asking = scoping?.status === "asking";

  const [activeList, setActiveList] = useState<BuyerList["id"]>("financial");

  useEffect(() => {
    // Conversations live in memory only; unknown ids (e.g. after a reload) go home.
    if (routeId && !getConversation(routeId)) router.replace("/");
  }, [routeId, getConversation, router]);

  function handleSubmit(text: string) {
    if (conversation) {
      sendMessage(conversation.id, text);
      return;
    }
    const id = startConversation(text);
    setPending({ id, from: pathname });
    router.push(`/c/${id}`);
  }

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-tl-xl border-t border-l border-line bg-white">
      {/* 11px inset on the left matches the search bar's (50 - 28) / 2 top gap. */}
      <header className="flex h-[50px] shrink-0 items-center px-[11px]">
        <AnimatePresence mode="wait" initial={false}>
          {mode === "chat" && conversation ? (
            <motion.h1
              key={conversation.id}
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: EASE, delay: 0.15 }}
              className="truncate px-2.5 font-serif text-[15px] font-medium"
            >
              {conversation.title}
            </motion.h1>
          ) : (
            <motion.button
              key="search"
              type="button"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
              className="flex h-[28px] w-[420px] items-center gap-2 rounded-lg bg-subtle px-2.5 text-[13px] text-muted"
            >
              <Search size={14} strokeWidth={2} className="text-ink" />
              <span className="flex-1 text-left">Search...</span>
              <span className="text-[11px] text-faint">Ctrl+K</span>
            </motion.button>
          )}
        </AnimatePresence>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Chat column: full width until research starts, then squashed to the left. */}
        <motion.div
          initial={false}
          animate={{ width: mode === "research" ? CHAT_COLUMN : "100%" }}
          transition={{ duration: 0.6, ease: EASE }}
          className="flex min-h-0 shrink-0 flex-col overflow-hidden"
        >
          {/* Spacers around the home group center it vertically (slightly above middle). */}
          {mode === "home" && <div className="flex-1" />}

          {mode === "home" && (
            <motion.div
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: EASE }}
              className="mx-auto w-full max-w-[51rem] px-4 pb-[26px]"
            >
              <Greeting />
            </motion.div>
          )}

          {mode === "research" && conversation && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.35, ease: EASE, delay: 0.3 }}
              className="flex h-10 shrink-0 items-center gap-1 pr-4 pl-6"
              style={{ width: CHAT_COLUMN }}
            >
              <h1 className="min-w-0 flex-1 truncate font-serif text-[17px] font-medium">
                {conversation.title}
              </h1>
              <IconButton label="More">
                <MoreHorizontal size={16} strokeWidth={1.75} />
              </IconButton>
            </motion.div>
          )}

          {conversation && (
            <Thread
              messages={conversation.messages}
              research={research}
              geography={scoping?.answers[0]}
              onOpenList={setActiveList}
            />
          )}

          <motion.div
            layout="position"
            transition={{ layout: { duration: 0.5, ease: EASE } }}
            className={`mx-auto w-full shrink-0 ${
              mode === "research"
                ? "px-6 pt-2 pb-4"
                : `max-w-[51rem] px-4 ${mode === "chat" ? "pt-2 pb-6" : ""}`
            }`}
            style={mode === "research" ? { width: CHAT_COLUMN } : undefined}
          >
            {/* The scoping questions take the composer's place until answered. */}
            <AnimatePresence mode="wait" initial={false}>
              {asking && conversation ? (
                <motion.div
                  key="questions"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
                  transition={{ duration: 0.3, ease: EASE }}
                >
                  <QuestionCard
                    questions={SCOPING_QUESTIONS}
                    step={scoping.answers.length}
                    onAnswer={(a) => answerQuestion(conversation.id, a)}
                    onDismiss={() => dismissQuestions(conversation.id)}
                  />
                </motion.div>
              ) : (
                <motion.div
                  key="composer"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0, transition: { duration: 0.15 } }}
                  transition={{ duration: 0.2 }}
                >
                  <Composer
                    variant={mode === "research" ? "panel" : mode}
                    onSubmit={handleSubmit}
                  />
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>

          {mode === "home" && <QuickChips />}

          {mode === "home" && <div className="flex-[1.4]" />}
        </motion.div>

        <AnimatePresence>
          {mode === "research" && research && (
            <ResearchTable
              key={conversation?.id}
              progress={research.progress}
              activeId={activeList}
              onActiveChange={setActiveList}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

const CHAT_COLUMN = 420;

function IconButton({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      className="flex size-8 shrink-0 items-center justify-center rounded-lg text-[#3a3a3f] transition-colors hover:bg-subtle"
    >
      {children}
    </button>
  );
}

const PROJECTS = [null, "Helios sample workspace"] as const;
type Project = (typeof PROJECTS)[number];

function QuickChips() {
  const [project, setProject] = useState<Project>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  return (
    // Left inset = wrapper px-4 (16) + composer border (1) + composer pl (24),
    // so the chip lines up with the text in the input box.
    <div className="mx-auto mt-2 flex w-full max-w-[51rem] items-center gap-2 px-[41px]">
      <div ref={ref} className="relative">
        <button
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`flex h-[30px] items-center gap-1.5 rounded-full border border-line px-3 text-[12.5px] font-medium transition-colors hover:bg-subtle ${open ? "bg-subtle" : ""}`}
        >
          <Folder
            size={13}
            strokeWidth={1.75}
            className={project ? "text-sky-ink" : undefined}
          />
          {project ?? "Choose project"}
          <ChevronDown
            size={14}
            strokeWidth={1.75}
            className={`transition-transform duration-200 ${open ? "rotate-180" : ""}`}
          />
        </button>
        <AnimatePresence>
          {open && (
            <motion.div
              role="menu"
              initial={{ opacity: 0, scale: 0.96, y: -4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
              transition={{ duration: 0.15, ease: "easeOut" }}
              className="absolute top-full left-0 z-20 mt-2 w-60 origin-top-left rounded-xl border border-line bg-white p-1 shadow-[0_4px_20px_rgba(0,0,0,0.08)]"
            >
              {PROJECTS.map((p) => (
                <button
                  key={p ?? "none"}
                  type="button"
                  role="menuitemradio"
                  aria-checked={project === p}
                  onClick={() => {
                    setProject(p);
                    setOpen(false);
                  }}
                  className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] transition-colors hover:bg-subtle"
                >
                  {p ? (
                    <Folder
                      size={15}
                      strokeWidth={1.75}
                      className="text-sky-ink"
                    />
                  ) : (
                    <Slash
                      size={15}
                      strokeWidth={1.75}
                      className="text-[#5d5d63]"
                    />
                  )}
                  <span className="flex-1 truncate">{p ?? "No project"}</span>
                  {project === p && <Check size={15} strokeWidth={2} />}
                </button>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

function Thread({
  messages,
  research,
  geography,
  onOpenList,
}: {
  messages: Message[];
  research?: Research;
  geography?: string;
  onOpenList: (id: BuyerList["id"]) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const last = messages.at(-1);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    atBottom.current = distance < 80;
    setShowJump(distance > 160);
  }

  function jumpToBottom() {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  // A new message always scrolls into view; streaming and research updates
  // only follow along if the reader hasn't scrolled up.
  useEffect(() => {
    atBottom.current = true;
    jumpToBottom();
  }, [messages.length]);
  useEffect(() => {
    if (atBottom.current) jumpToBottom();
  }, [last?.content.length, last?.status, last?.progress, research?.progress]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {/* Fades messages out as they scroll up under the title header. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 z-10 h-10 bg-gradient-to-b from-white to-transparent"
      />
      <div
        ref={scrollRef}
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-[49rem] min-w-[380px] flex-col gap-8 px-6 pt-8 pb-10">
          {messages.map((m) =>
            m.role === "user" ? (
              <motion.div
                key={m.id}
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.45, ease: EASE, delay: 0.1 }}
                className="max-w-[80%] self-end rounded-[20px] bg-subtle px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap"
              >
                {m.content}
              </motion.div>
            ) : (
              <motion.div
                key={m.id}
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                transition={{ duration: 0.3, delay: 0.35 }}
                className="text-[15px] leading-[1.7]"
              >
                {m.kind === "research" ? (
                  <ResearchMessage
                    message={m}
                    research={research}
                    geography={geography}
                    onOpenList={onOpenList}
                  />
                ) : m.kind === "intake" ? (
                  <IntakeMessage message={m} />
                ) : (
                  <>
                    {m.status === "thinking" ? (
                      <ThinkingGrid />
                    ) : (
                      <div className="whitespace-pre-wrap">{m.content}</div>
                    )}
                    <AnimatePresence>
                      {m.status === "done" && (
                        <motion.div
                          initial={{ opacity: 0 }}
                          animate={{ opacity: 1 }}
                          transition={{ duration: 0.25 }}
                          className="mt-2"
                        >
                          <CopyButton text={m.content} />
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </>
                )}
              </motion.div>
            ),
          )}
        </div>
      </div>
      {/* Mirror of the top fade: messages fade out as they scroll under the composer. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-10 bg-gradient-to-t from-white to-transparent"
      />
      <AnimatePresence>
        {showJump && (
          <motion.button
            type="button"
            aria-label="Scroll to latest"
            onClick={jumpToBottom}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.2 }}
            className="absolute bottom-3 left-1/2 z-10 flex size-8 -translate-x-1/2 items-center justify-center rounded-full border border-line bg-white text-ink shadow-[0_2px_8px_rgba(0,0,0,0.08)]"
          >
            <ArrowDown size={15} strokeWidth={1.75} />
          </motion.button>
        )}
      </AnimatePresence>
    </div>
  );
}
