"use client";

import { AnimatePresence, motion } from "motion/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowDown, MoreHorizontal, Table } from "react-feather";
import {
  companyFromMessage,
  useChat,
  type Attachment,
  type Message,
  type Research,
} from "@/lib/chat";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { MERGE_QUESTION, type BuyerList } from "@/lib/research";
import { Composer, FileCard } from "./Composer";
import { CopyButton } from "./CopyButton";
import { FLOW_QUESTIONS, geographyFrom } from "@/lib/scoping";
import { QuestionCard } from "./QuestionCard";
import {
  IntakeMessage,
  MergeMessage,
  RefineMessage,
  ResearchMessage,
  StoppedNote,
} from "./ResearchMessage";
import { ResearchTable } from "./ResearchTable";
import { ThinkingGrid } from "./ThinkingGrid";

const EASE = [0.32, 0.72, 0, 1] as const;

// Home and chat share one persistent tree, so the composer can glide from the
// hero position down to the bottom instead of the page swapping abruptly.
const NAME = "Vanya";

const TAGLINES: MessageKey[] = [
  "What’s your next move?",
  "Happy to Helbling",
  "Need a Helbling hand?",
];

function timeGreeting(): MessageKey {
  const h = new Date().getHours();
  return h >= 5 && h < 12
    ? "Good morning, {name}"
    : h >= 12 && h < 18
      ? "Good afternoon, {name}"
      : "Good evening, {name}";
}

// Half the time a time-of-day greeting, otherwise one of the taglines.
function pickGreeting() {
  return Math.random() < 0.5
    ? timeGreeting()
    : TAGLINES[Math.floor(Math.random() * TAGLINES.length)];
}

function Greeting() {
  const { t } = useI18n();
  // Chosen once per mount, so it changes each time you come back home; the
  // key is kept so switching language re-translates the same greeting.
  const [key] = useState(pickGreeting);
  const greeting = t(key, { name: NAME });
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
    stopGenerating,
    answerMerge,
    dismissMerge,
  } = useChat();
  const { t } = useI18n();

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
  // After a spreadsheet: merge into the financial list, new list, or cancel.
  const mergeAsking = research?.merge?.status === "asking";
  const [files, setFiles] = useState<Attachment[]>([]);
  const generating =
    conversation?.messages.some((m) => m.status !== "done") ?? false;

  const [activeList, setActiveList] = useState<BuyerList["id"]>("financial");
  // A finished merge shows its list, where the new row is.
  const mergeDone = research?.merge?.status === "done";
  const [sawMerge, setSawMerge] = useState(mergeDone);
  if (mergeDone !== sawMerge) {
    setSawMerge(mergeDone);
    if (mergeDone) setActiveList("financial");
  }

  useEffect(() => {
    // Conversations live in memory only; unknown ids (e.g. after a reload) go home.
    if (routeId && !getConversation(routeId)) router.replace("/");
  }, [routeId, getConversation, router]);

  function handleSubmit(text: string) {
    const sent = files;
    setFiles([]);
    // While the question is open, typed text is its free-text answer.
    if (conversation && asking) {
      answerQuestion(conversation.id, text);
      return;
    }
    // Typing instead of choosing drops the merge offer.
    if (conversation && mergeAsking) dismissMerge(conversation.id);
    if (conversation) {
      sendMessage(conversation.id, text, sent);
      return;
    }
    const id = startConversation(text, sent);
    setPending({ id, from: pathname });
    router.push(`/c/${id}`);
  }

  const drop = useFileDrop((dropped) => setFiles((f) => [...f, ...dropped]));

  return (
    <div
      {...drop.handlers}
      className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-tl-xl border-t border-l border-line bg-white"
    >
      <DropOverlay visible={drop.over} />
      {/* Holds the chat title; empty on home, and collapsed in research (the
          title moves into the chat column, which then starts at the top). */}
      <motion.header
        initial={false}
        animate={{ height: mode === "research" ? 0 : 50 }}
        transition={{ duration: 0.6, ease: EASE }}
        className="flex shrink-0 items-center overflow-hidden px-[11px]"
      >
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
          ) : null}
        </AnimatePresence>
      </motion.header>

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
              className="mt-2 flex h-10 shrink-0 items-center gap-1 pr-4 pl-6"
              style={{ width: CHAT_COLUMN }}
            >
              <h1 className="min-w-0 flex-1 truncate font-serif text-[17px] font-medium">
                {conversation.title}
              </h1>
              <IconButton label={t("More")}>
                <MoreHorizontal size={16} strokeWidth={1.75} />
              </IconButton>
            </motion.div>
          )}

          {conversation && (
            <Thread
              messages={conversation.messages}
              research={research}
              geography={geographyFrom(scoping?.answers)}
              onOpenList={setActiveList}
            />
          )}

          <motion.div
            layout="position"
            transition={{ layout: { duration: 0.5, ease: EASE } }}
            // Above the thread's bottom fade, so tooltips aren't covered.
            className={`relative z-20 mx-auto w-full shrink-0 ${
              mode === "research"
                ? "px-6 pt-2 pb-3"
                : `max-w-[51rem] px-4 ${mode === "chat" ? "pt-2 pb-6" : ""}`
            }`}
            style={mode === "research" ? { width: CHAT_COLUMN } : undefined}
          >
            {/* The scoping question's answers float above the composer, which
                stays the input for a free-text answer. */}
            <AnimatePresence initial={false}>
              {asking && conversation && (
                <motion.div
                  key="questions"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
                  transition={{ duration: 0.3, ease: EASE }}
                  className="mb-2"
                >
                  <QuestionCard
                    questions={FLOW_QUESTIONS}
                    step={scoping.answers.length}
                    onAnswer={(a) => answerQuestion(conversation.id, a)}
                    onDismiss={() => dismissQuestions(conversation.id)}
                  />
                </motion.div>
              )}
              {mergeAsking && conversation && (
                <motion.div
                  key="merge"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
                  transition={{ duration: 0.3, ease: EASE }}
                  className="mb-2"
                >
                  <QuestionCard
                    questions={[MERGE_QUESTION]}
                    step={0}
                    onAnswer={(a) => answerMerge(conversation.id, a)}
                    onDismiss={() => dismissMerge(conversation.id)}
                  />
                </motion.div>
              )}
            </AnimatePresence>
            <Composer
              variant={mode === "research" ? "panel" : mode}
              onSubmit={handleSubmit}
              generating={generating}
              onStop={() => conversation && stopGenerating(conversation.id)}
              files={files}
              onAddFiles={(added) => setFiles((f) => [...f, ...added])}
              onRemoveFile={(i) => setFiles((f) => f.filter((_, j) => j !== i))}
            />
          </motion.div>

          {mode === "home" && <div className="flex-[1.4]" />}
        </motion.div>

        <AnimatePresence>
          {mode === "research" && research && (
            <ResearchTable
              key={conversation?.id}
              progress={research.progress}
              refine={research.refine}
              merge={research.merge}
              company={companyFromMessage(
                conversation?.messages[0]?.content ?? "",
              )}
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
  const { t } = useI18n();
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
                className="flex max-w-[80%] flex-col items-end gap-2 self-end"
              >
                {/* Sent files sit above the bubble, like the composer's cards. */}
                {m.files && (
                  <div className="flex flex-wrap justify-end gap-2">
                    {m.files.map((f, i) => (
                      <FileCard key={`${f.name}-${i}`} file={f} />
                    ))}
                  </div>
                )}
                {m.content && (
                  <div className="rounded-[20px] bg-subtle px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
                    {m.content}
                  </div>
                )}
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
                ) : m.kind === "merge" ? (
                  <MergeMessage message={m} />
                ) : m.kind === "refine" ? (
                  <RefineMessage
                    message={m}
                    research={research}
                    onOpenList={onOpenList}
                  />
                ) : m.kind === "intake" ? (
                  <IntakeMessage message={m} />
                ) : (
                  <>
                    {m.status === "thinking" ? (
                      <ThinkingGrid />
                    ) : m.stopped && !m.content ? (
                      <StoppedNote />
                    ) : (
                      <div className="whitespace-pre-wrap">{m.content}</div>
                    )}
                    <AnimatePresence>
                      {m.status === "done" && m.content && (
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
            aria-label={t("Scroll to latest")}
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

// Dragging files over the workspace shows the drop overlay; dropping adds
// them to the composer. A counter, because dragenter/leave also fire for
// every child element crossed.
function useFileDrop(onDrop: (files: Attachment[]) => void) {
  const [depth, setDepth] = useState(0);
  const hasFiles = (e: React.DragEvent) =>
    e.dataTransfer.types.includes("Files");
  return {
    over: depth > 0,
    handlers: {
      onDragEnter: (e: React.DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDepth((d) => d + 1);
      },
      onDragLeave: (e: React.DragEvent) => {
        if (hasFiles(e)) setDepth((d) => Math.max(0, d - 1));
      },
      onDragOver: (e: React.DragEvent) => {
        if (hasFiles(e)) e.preventDefault();
      },
      onDrop: (e: React.DragEvent) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        setDepth(0);
        const dropped = [...e.dataTransfer.files].map(({ name, size }) => ({
          name,
          size,
        }));
        if (dropped.length) onDrop(dropped);
      },
    },
  };
}

function DropOverlay({ visible }: { visible: boolean }) {
  const { t } = useI18n();
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          // Ignores the pointer, so drag events keep reaching the workspace.
          className="pointer-events-none absolute inset-0 z-50 flex flex-col items-center justify-center bg-white/85 backdrop-blur-[2px]"
        >
          <span className="flex size-14 items-center justify-center rounded-2xl border border-line bg-white">
            <Table size={26} strokeWidth={1.75} className="text-sheet" />
          </span>
          <h2 className="mt-5 text-[17px] font-medium">
            {t("Add Excel file")}
          </h2>
          <p className="mt-1.5 text-[13.5px] text-muted">
            {t("Drop Excel file to add it to the conversation")}
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
