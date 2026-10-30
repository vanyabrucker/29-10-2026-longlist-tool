"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, ChevronUp, CornerDownLeft } from "react-feather";
import type { ScopingQuestion } from "@/lib/scoping";

const EASE = [0.32, 0.72, 0, 1] as const;

/**
 * Asks the scoping questions one at a time in place of the composer.
 * Arrows move, 1–n picks, Enter submits, Esc dismisses.
 */
export function QuestionCard({
  questions,
  step,
  onAnswer,
  onDismiss,
}: {
  questions: ScopingQuestion[];
  step: number;
  onAnswer: (answer: string) => void;
  onDismiss: () => void;
}) {
  const question = questions[step];
  if (!question) return null;

  return (
    <div className="rounded-2xl border border-line bg-white p-2">
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
            position={`${step + 1} of ${questions.length}`}
            onAnswer={onAnswer}
            onDismiss={onDismiss}
          />
        </motion.div>
      </AnimatePresence>
    </div>
  );
}

function Question({
  question,
  position,
  onAnswer,
  onDismiss,
}: {
  question: ScopingQuestion;
  position: string;
  onAnswer: (answer: string) => void;
  onDismiss: () => void;
}) {
  const [active, setActive] = useState(0);
  const [custom, setCustom] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // The last row is the free-text "Type your own".
  const customIndex = question.options.length;
  const count = customIndex + 1;

  function submit(index = active) {
    if (index !== customIndex) return onAnswer(question.options[index]);
    const text = custom.trim();
    if (text) onAnswer(text);
    else inputRef.current?.focus();
  }

  // The free-text row takes focus whenever it's the active one.
  useEffect(() => {
    if (active === customIndex) inputRef.current?.focus();
    else inputRef.current?.blur();
  }, [active, customIndex]);

  // Re-subscribed each render so the handler always sees current state.
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.isComposing) return;
      const typing = document.activeElement === inputRef.current;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        const delta = e.key === "ArrowDown" ? 1 : -1;
        setActive((a) => (a + delta + count) % count);
      } else if (e.key === "Enter") {
        e.preventDefault();
        submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        onDismiss();
      } else if (!typing && /^[1-9]$/.test(e.key) && Number(e.key) <= count) {
        e.preventDefault();
        const index = Number(e.key) - 1;
        setActive(index);
        if (index !== customIndex) submit(index);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  return (
    <div>
      {/* Title and footer start at the badges' left edge (row px-3). */}
      <div className="flex items-baseline justify-between gap-4 px-3 pt-2.5 pb-2">
        <h3 className="font-serif text-[19px] leading-tight tracking-[-0.01em]">
          {question.question}
        </h3>
        <span className="shrink-0 text-[13px] text-faint tabular-nums">
          {position}
        </span>
      </div>

      <div role="listbox" aria-label={question.question}>
        {[...question.options, null].map((option, i) => (
          <div
            key={option ?? "custom"}
            role="option"
            aria-selected={active === i}
            onMouseEnter={() => setActive(i)}
            onClick={() => (option === null ? setActive(i) : submit(i))}
            className={`flex h-10 cursor-pointer items-center gap-3 rounded-xl px-3 text-[14.5px] transition-colors ${active === i ? "bg-subtle text-ink" : "text-[#3a3a3f]"}`}
          >
            <span className="flex size-[22px] shrink-0 items-center justify-center rounded-md bg-subtle text-[12px] text-muted tabular-nums">
              {i + 1}
            </span>
            {option ?? (
              <input
                ref={inputRef}
                value={custom}
                onChange={(e) => setCustom(e.target.value)}
                onFocus={() => setActive(i)}
                placeholder="Type your own"
                aria-label="Type your own answer"
                className="min-w-0 flex-1 bg-transparent outline-none placeholder:text-faint"
              />
            )}
          </div>
        ))}
      </div>

      <div className="mt-1 flex items-center gap-1 py-1 pr-1 pl-3 text-[13px] text-faint">
        <ChevronUp size={14} strokeWidth={1.75} />
        <ChevronDown size={14} strokeWidth={1.75} />
        <span className="ml-1.5">to navigate</span>

        <button
          type="button"
          onClick={onDismiss}
          className="ml-auto flex h-8 items-center gap-2 rounded-lg px-2 text-muted transition-colors hover:bg-subtle hover:text-ink"
        >
          Dismiss
          <kbd className="rounded bg-subtle px-1.5 py-px font-sans text-[11px] text-muted">
            Esc
          </kbd>
        </button>
        <button
          type="button"
          onClick={() => submit()}
          className="ml-1 flex h-8 items-center gap-2 rounded-lg bg-ink pr-1.5 pl-3 text-[13.5px] font-medium text-white transition-colors hover:bg-[#26262a]"
        >
          Submit
          <kbd className="flex size-5 items-center justify-center rounded bg-white/15">
            <CornerDownLeft size={11} strokeWidth={2} />
          </kbd>
        </button>
      </div>
    </div>
  );
}
