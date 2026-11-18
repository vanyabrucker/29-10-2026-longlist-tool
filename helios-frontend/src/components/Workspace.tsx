"use client";

import { AnimatePresence, motion } from "motion/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ArrowDown } from "react-feather";
import {
  useChat,
  type Attachment,
  type Message,
  type ThreadItem,
} from "@/lib/chat";
import { firstName, useUser } from "@/lib/auth";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { Composer } from "./Composer";
import { CopyButton } from "./CopyButton";
import { Markdown } from "./Markdown";
import { QuestionCard, type Question } from "./QuestionCard";
import { SessionListPanel } from "./SessionListPanel";
import { ThinkingGrid } from "./ThinkingGrid";
import { WorkLog } from "./WorkLog";

const EASE = [0.32, 0.72, 0, 1] as const;

const TAGLINES: MessageKey[] = [
  "What’s your next move?",
  "Happy to Helbling",
  "Need a Helbling hand?",
  "An Excel-lent day!",
];

function timeGreeting(): MessageKey {
  const h = new Date().getHours();
  return h >= 5 && h < 12
    ? "Good morning, {name}"
    : h >= 12 && h < 18
      ? "Good afternoon, {name}"
      : "Good evening, {name}";
}

function pickGreeting() {
  return Math.random() < 0.5
    ? timeGreeting()
    : TAGLINES[Math.floor(Math.random() * TAGLINES.length)];
}

function Greeting() {
  const { t } = useI18n();
  const [key] = useState(pickGreeting);
  const user = useUser();
  const greeting = t(key, { name: user ? firstName(user) : "" });
  return (
    <h2 className="text-center font-serif text-[2.1rem] leading-tight tracking-[-0.01em]">
      {greeting}
    </h2>
  );
}

function StoppedNote() {
  const { t } = useI18n();
  return <div className="text-[14px] text-muted">{t("Stopped")}</div>;
}

export function Workspace() {
  const pathname = usePathname();
  const router = useRouter();
  const {
    getConversation,
    ensureConversation,
    startConversation,
    sendMessage,
    answerQuestion,
    dismissQuestions,
    stopGenerating,
    leaveConversation,
  } = useChat();

  const [pending, setPending] = useState<{ id: string; from: string } | null>(
    null,
  );
  const [lastPathname, setLastPathname] = useState(pathname);
  if (pathname !== lastPathname) {
    setLastPathname(pathname);
    setPending(null);
  }
  const routeId = pathname.startsWith("/c/") ? pathname.slice(3) : null;
  const activeId = pending && pending.from === pathname ? pending.id : routeId;
  const conversation = activeId ? getConversation(activeId) : undefined;
  const hasList =
    !!conversation?.hasList && (conversation.listIds?.length ?? 0) > 0;
  const mode = hasList ? "research" : conversation ? "chat" : "home";
  const asking = !!conversation?.pendingAsk;
  const [files, setFiles] = useState<Attachment[]>([]);
  const generating = conversation?.busy ?? false;
  const [pickedListId, setPickedListId] = useState<string | null>(null);
  const activeListId = conversation?.listIds?.length
    ? pickedListId && conversation.listIds.includes(pickedListId)
      ? pickedListId
      : conversation.listIds[0]
    : null;

  useEffect(() => {
    if (!routeId) return;
    let live = true;
    ensureConversation(routeId).then((c) => {
      if (!live) return;
      if (!c) router.replace("/");
    });
    return () => {
      live = false;
    };
  }, [routeId, ensureConversation, router]);

  // Only the chat on screen is streamed.
  useEffect(() => {
    if (!activeId) leaveConversation();
  }, [activeId, leaveConversation]);

  async function handleSubmit(text: string) {
    const sent = files;
    setFiles([]);
    void sent; // phase 5: spreadsheet upload
    if (conversation && asking) {
      await answerQuestion(conversation.id, text);
      return;
    }
    if (conversation) {
      await sendMessage(conversation.id, text);
      return;
    }
    const id = await startConversation(text);
    setPending({ id, from: pathname });
    router.push(`/c/${id}`);
  }

  // Upload control stays visible but inert until phase 5.
  const drop = useFileDrop();

  return (
    <div
      {...drop.handlers}
      className="relative flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-tl-xl border-t border-l border-line bg-white"
    >
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
              {conversation.title || "…"}
            </motion.h1>
          ) : null}
        </AnimatePresence>
      </motion.header>

      <div className="flex min-h-0 flex-1">
        <motion.div
          initial={false}
          animate={{ width: mode === "research" ? CHAT_COLUMN : "100%" }}
          transition={{ duration: 0.6, ease: EASE }}
          className="flex min-h-0 shrink-0 flex-col overflow-hidden"
        >
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
                {conversation.title || "…"}
              </h1>
            </motion.div>
          )}

          {conversation && (
            <Thread messages={conversation.messages} busy={conversation.busy} />
          )}

          <motion.div
            layout="position"
            transition={{ layout: { duration: 0.5, ease: EASE } }}
            className={`relative z-20 mx-auto w-full shrink-0 ${
              mode === "research"
                ? "px-6 pt-2 pb-3"
                : `max-w-[51rem] px-4 ${mode === "chat" ? "pt-2 pb-6" : ""}`
            }`}
            style={mode === "research" ? { width: CHAT_COLUMN } : undefined}
          >
            <AnimatePresence initial={false}>
              {asking && conversation?.pendingAsk && (
                <motion.div
                  key="questions"
                  initial={{ opacity: 0, y: 8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
                  transition={{ duration: 0.3, ease: EASE }}
                  className="mb-2"
                >
                  <QuestionCard
                    questions={[
                      {
                        question: conversation.pendingAsk.question,
                        options: conversation.pendingAsk.options?.length
                          ? conversation.pendingAsk.options
                          : [],
                        detail: conversation.pendingAsk.query || undefined,
                      } satisfies Question,
                    ]}
                    step={0}
                    onAnswer={(a) => answerQuestion(conversation.id, a)}
                    onDismiss={() => dismissQuestions(conversation.id)}
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
              onAddFiles={() => {
                /* phase 5: inert */
              }}
              onRemoveFile={(i) => setFiles((f) => f.filter((_, j) => j !== i))}
            />
          </motion.div>

          {mode === "home" && <div className="flex-[1.4]" />}
        </motion.div>

        <AnimatePresence>
          {mode === "research" && activeListId && (
            <SessionListPanel
              key={conversation?.id}
              listIds={conversation?.listIds ?? []}
              activeId={activeListId}
              onActiveChange={setPickedListId}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

const CHAT_COLUMN = 520;

/** User bubble vs one assistant turn (prose + work log stay tight). */
type ThreadGroup =
  { type: "user"; item: Message } | { type: "assistant"; items: ThreadItem[] };

function isUserMessage(m: ThreadItem): m is Message & { role: "user" } {
  return !("kind" in m && m.kind === "work") && m.role === "user";
}

function groupThread(messages: ThreadItem[]): ThreadGroup[] {
  const groups: ThreadGroup[] = [];
  for (const m of messages) {
    if (isUserMessage(m)) {
      groups.push({ type: "user", item: m });
      continue;
    }
    const last = groups.at(-1);
    if (last?.type === "assistant") last.items.push(m);
    else groups.push({ type: "assistant", items: [m] });
  }
  return groups;
}

function Thread({ messages, busy }: { messages: ThreadItem[]; busy: boolean }) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const last = messages.at(-1);
  const lastWorkSteps =
    last && "kind" in last && last.kind === "work" ? last.steps.length : 0;
  const lastContent =
    last && (!("kind" in last) || last.kind !== "work")
      ? last.content.length
      : 0;
  const lastStatus = last?.status;
  const groups = groupThread(messages);

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

  useEffect(() => {
    atBottom.current = true;
    jumpToBottom();
  }, [messages.length]);
  useEffect(() => {
    if (atBottom.current) jumpToBottom();
  }, [lastContent, lastStatus, lastWorkSteps]);

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
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
          {groups.map((g, gi) =>
            g.type === "user" ? (
              <motion.div
                key={g.item.id}
                initial={{ opacity: 0, y: 24 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.45, ease: EASE, delay: 0.1 }}
                className="flex max-w-[80%] flex-col items-end gap-2 self-end"
              >
                {g.item.content && (
                  <div className="rounded-[20px] bg-subtle px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap">
                    {g.item.content}
                  </div>
                )}
              </motion.div>
            ) : (
              <div
                key={`a-${gi}-${g.items[0]?.id}`}
                className="flex flex-col gap-3"
              >
                {g.items.map((m) =>
                  "kind" in m && m.kind === "work" ? (
                    <motion.div
                      key={m.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.3 }}
                    >
                      <WorkLog block={m} />
                    </motion.div>
                  ) : (
                    <motion.div
                      key={m.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.3, delay: 0.15 }}
                      className="text-[15px] leading-[1.7]"
                    >
                      {m.status === "streaming" && !m.content ? (
                        <ThinkingGrid />
                      ) : m.stopped && !m.content ? (
                        <StoppedNote />
                      ) : (
                        <>
                          {m.status === "streaming" ? (
                            <div className="whitespace-pre-wrap">
                              {m.content}
                            </div>
                          ) : (
                            <Markdown>{m.content}</Markdown>
                          )}
                          <AnimatePresence>
                            {!busy && m.status === "done" && m.content && (
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
            ),
          )}
        </div>
      </div>
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

function useFileDrop() {
  return {
    over: false,
    handlers: {
      onDragEnter: (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      },
      onDragLeave: () => {},
      onDragOver: (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      },
      onDrop: (e: React.DragEvent) => {
        if (e.dataTransfer.types.includes("Files")) e.preventDefault();
      },
    },
  };
}
