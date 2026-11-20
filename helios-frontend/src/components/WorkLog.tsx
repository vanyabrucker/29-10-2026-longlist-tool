"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Check, ChevronRight } from "@/components/icons";
import type { WorkBlock } from "@/lib/workLog";
import { useI18n } from "@/lib/i18n";
import { ThinkingGrid } from "./ThinkingGrid";

const EASE = [0.32, 0.72, 0, 1] as const;

function formatDuration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

/** Live / collapsible tool progress for one agent run. */
export function WorkLog({ block }: { block: WorkBlock }) {
  const { t } = useI18n();
  const running = block.status === "streaming";
  const now = useNow(running);
  const [stepsOpen, setStepsOpen] = useState(false);
  const elapsed = (block.finishedAt ?? now) - block.startedAt;
  const steps = block.steps;

  if (steps.length === 0 && running) {
    return <ThinkingGrid />;
  }
  if (steps.length === 0) return null;

  return (
    <div>
      {running ? (
        <div className="flex items-center gap-2.5 text-[14px] text-muted">
          <ThinkingGrid />
          <span>{t("Working… {time}", { time: formatDuration(elapsed) })}</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setStepsOpen((o) => !o)}
          aria-expanded={stepsOpen}
          className="flex items-center gap-1 text-[14px] text-muted transition-colors hover:text-ink"
        >
          {t(
            block.failed
              ? "Failed after {time}"
              : block.stopped
                ? "Stopped after {time}"
                : "Worked for {time}",
            {
              time: formatDuration(elapsed),
            },
          )}
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            className={`transition-transform duration-200 ${stepsOpen ? "rotate-90" : ""}`}
          />
        </button>
      )}

      <AnimatePresence initial={false}>
        {(running || stepsOpen) && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="overflow-hidden"
          >
            <ul className="mt-2.5 space-y-2 rounded-xl border border-line px-3 py-2.5">
              {steps.map((s, i) => {
                const current = running && s.status === "running";
                const isLastRunning =
                  current &&
                  steps.slice(i + 1).every((x) => x.status !== "running");
                return (
                  <motion.li
                    key={s.id}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: EASE }}
                    className={`flex items-center gap-2 text-[13.5px] ${
                      current && isLastRunning
                        ? "text-ink"
                        : s.status === "error"
                          ? "text-muted"
                          : "text-muted"
                    }`}
                  >
                    <span className="flex size-[18px] shrink-0 items-center justify-center">
                      {current ? (
                        <span className="size-1.5 animate-pulse bg-brand" />
                      ) : s.status === "error" ? (
                        <span className="size-1.5 rounded-full bg-faint" />
                      ) : (
                        <Check size={13} strokeWidth={2} />
                      )}
                    </span>
                    <span className="min-w-0">{s.label}</span>
                  </motion.li>
                );
              })}
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
