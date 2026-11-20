"use client";

import { AnimatePresence, motion } from "motion/react";
import { Fragment, useEffect, useState } from "react";
import { CornerDownLeft } from "@/components/icons";
import { useI18n } from "@/lib/i18n";

const EASE = [0.32, 0.72, 0, 1] as const;

/** Matches the gateway's OPT_ALLOW_QUERY label. */
const ALLOW_THIS_SEARCH = "Allow this search";

export type Question = {
  question: string;
  options: string[];
  /** Exact web query to approve (shown under "Allow this search"). */
  detail?: string;
};

/**
 * Preset answers floating above the composer (ask_user). The composer itself
 * takes a free-text answer. While empty, arrows move, Enter picks the
 * highlighted answer and Esc dismisses.
 */
export function QuestionCard({
  questions,
  step,
  onAnswer,
  onDismiss,
}: {
  questions: Question[];
  step: number;
  onAnswer: (answer: string) => void;
  onDismiss: () => void;
}) {
  const question = questions[step];
  if (!question) return null;

  return (
    <div className="rounded-2xl border border-line bg-white p-2 shadow-[0_4px_20px_rgba(0,0,0,0.06)]">
      <AnimatePresence mode="wait" initial={false}>
        <motion.div
          key={step}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, transition: { duration: 0.12 } }}
          transition={{ duration: 0.25, ease: EASE }}
        >
          <Question
            question={question}
            // No counter for a single question.
            position={
              questions.length > 1 ? `${step + 1} of ${questions.length}` : ""
            }
            onAnswer={onAnswer}
            onDismiss={onDismiss}
          />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

// True while the user is writing their own answer in the composer.
function composing() {
  const el = document.activeElement;
  return el instanceof HTMLTextAreaElement && el.value.trim() !== "";
}

function QueryBox({ query }: { query: string }) {
  const { t } = useI18n();
  return (
    <div className="mx-1 mt-1.5 mb-1 rounded-xl border border-line px-3 py-2">
      <p className="font-mono text-[13px] leading-snug break-words text-ink">
        <span className="text-faint uppercase">{t("Query")}: </span>
        {query}
      </p>
    </div>
  );
}

function Question({
  question,
  position,
  onAnswer,
  onDismiss,
}: {
  question: Question;
  position: string;
  onAnswer: (answer: string) => void;
  onDismiss: () => void;
}) {
  const { t } = useI18n();
  const [active, setActive] = useState(0);
  // While the composer holds text, Enter belongs to it, so no answer is
  // highlighted (hover still is, for clicking).
  const [typing, setTyping] = useState(false);
  useEffect(() => {
    const onInput = () => setTyping(composing());
    document.addEventListener("input", onInput);
    return () => document.removeEventListener("input", onInput);
  }, []);
  const highlighted = typing ? -1 : active;
  const count = question.options.length;
  const query = question.detail?.trim() || "";

  // Re-subscribed each render so the handler always sees current state.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.isComposing || composing()) return;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setActive((a) => (a + delta + count) % count);
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        onAnswer(question.options[active]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div>
      {/* Title starts at the answers' text (row px-3). */}
      <div className="flex items-start justify-between gap-4 pt-1.5 pb-1.5 pl-3">
        <h3 className="line-clamp-2 min-w-0 font-serif text-[19px] leading-tight tracking-[-0.01em]">
          {question.question.length > 120
            ? `${question.question.slice(0, 119).trimEnd()}…`
            : question.question}
        </h3>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {position && (
            <span className="text-[13px] text-faint tabular-nums">
              {position}
            </span>
          )}
          <button
            type="button"
            onClick={onDismiss}
            className="flex h-8 items-center gap-2 rounded-full px-2.5 text-[13px] text-muted transition-colors hover:bg-subtle hover:text-ink"
          >
            {t("Dismiss")}
            <kbd className="rounded border border-line bg-subtle px-1.5 py-px font-sans text-[11px] text-muted">
              Esc
            </kbd>
          </button>
        </div>
      </div>

      <div role="listbox" aria-label={question.question}>
        {question.options.map((option, i) => (
          <Fragment key={option}>
            <div
              role="option"
              aria-selected={highlighted === i}
              onMouseEnter={() => setActive(i)}
              onClick={() => onAnswer(option)}
              className={`flex h-10 cursor-pointer items-center gap-3 rounded-xl px-3 text-[14.5px] transition-colors ${highlighted === i ? "bg-subtle text-ink" : "text-[#3a3a3f] hover:bg-subtle"}`}
            >
              {option}
              {/* Enter picks the highlighted answer. */}
              {highlighted === i && (
                <kbd className="ml-auto flex size-[22px] items-center justify-center rounded-md border border-line bg-white text-muted">
                  <CornerDownLeft size={11} strokeWidth={2} />
                </kbd>
              )}
            </div>
            {query && option === ALLOW_THIS_SEARCH ? (
              <QueryBox query={query} />
            ) : null}
          </Fragment>
        ))}
      </div>
      {/* Query-only approval with no matching option label: still show it. */}
      {query && !question.options.includes(ALLOW_THIS_SEARCH) ? (
        <QueryBox query={query} />
      ) : null}
    </div>
  );
}
