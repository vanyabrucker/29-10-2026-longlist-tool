"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Check, ChevronRight } from "react-feather";
import type { Message, Research } from "@/lib/chat";
import { RESEARCH_STEPS, type BuyerList } from "@/lib/research";
import { CopyButton } from "./CopyButton";
import { ThinkingGrid } from "./ThinkingGrid";

const EASE = [0.32, 0.72, 0, 1] as const;

function formatDuration(ms: number) {
  const s = Math.max(1, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

// Re-renders once a second while research runs, for the live timer.
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

export function ResearchMessage({
  message,
  research,
  onOpenList,
}: {
  message: Message;
  research?: Research;
  onOpenList: (id: BuyerList["id"]) => void;
}) {
  const running = message.status === "researching";
  const done = message.status === "done";
  const now = useNow(running);
  const [stepsOpen, setStepsOpen] = useState(false);

  if (message.status === "thinking") return <ThinkingGrid />;

  const progress = done ? 1 : (research?.progress ?? 0);
  const elapsed = (message.finishedAt ?? now) - (message.startedAt ?? now);
  const reached = RESEARCH_STEPS.filter((s) => s.at <= progress);

  return (
    <div>
      {running ? (
        <div className="flex items-center gap-2.5 text-[14px] text-muted">
          <ThinkingGrid />
          <span>Working… {formatDuration(elapsed)}</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setStepsOpen((o) => !o)}
          aria-expanded={stepsOpen}
          className="flex items-center gap-1 text-[14px] text-muted transition-colors hover:text-ink"
        >
          Worked for {formatDuration(elapsed)}
          <ChevronRight
            size={14}
            strokeWidth={1.75}
            className={`transition-transform duration-200 ${stepsOpen ? "rotate-90" : ""}`}
          />
        </button>
      )}

      <AnimatePresence initial={false}>
        {(running || stepsOpen) && (
          <motion.ul
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="overflow-hidden"
          >
            {reached.map((s, i) => {
              const current = running && i === reached.length - 1;
              return (
                <motion.li
                  key={s.label}
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, ease: EASE }}
                  className={`flex items-center gap-2 pt-2 text-[13.5px] ${current ? "text-ink" : "text-muted"}`}
                >
                  <span className="flex size-[18px] shrink-0 items-center justify-center">
                    {current ? (
                      <span className="size-1.5 animate-pulse bg-brand" />
                    ) : (
                      <Check size={13} strokeWidth={2} />
                    )}
                  </span>
                  {s.label}
                </motion.li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>

      {done && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.45, ease: EASE, delay: 0.1 }}
        >
          <Summary onOpenList={onOpenList} />
          <div className="mt-2">
            <CopyButton text={message.content} />
          </div>
        </motion.div>
      )}
    </div>
  );
}

const link =
  "underline decoration-[#b5b5ba] decoration-1 underline-offset-[3px] transition-colors hover:decoration-ink";

function Co({ children }: { children: React.ReactNode }) {
  return <span className={`${link} cursor-pointer`}>{children}</span>;
}

type OpenList = (id: BuyerList["id"]) => void;

// Opens that list's tab in the table.
function ListLink({
  id,
  onOpenList,
  children,
}: {
  id: BuyerList["id"];
  onOpenList: OpenList;
  children: React.ReactNode;
}) {
  return (
    <button type="button" onClick={() => onOpenList(id)} className={link}>
      {children}
    </button>
  );
}

// Rich version of RESEARCH_SUMMARY_TEXT (lib/chat.tsx); keep the two in sync.
function Summary({ onOpenList }: { onOpenList: OpenList }) {
  return (
    <div className="mt-4 space-y-4 text-[15px] leading-[1.7]">
      <p>
        I&apos;ve built two global buyer lists:{" "}
        <ListLink id="strategic" onOpenList={onOpenList}>
          Strategic buyers
        </ListLink>{" "}
        with 1,608 companies and{" "}
        <ListLink id="financial" onOpenList={onOpenList}>
          Financial buyers
        </ListLink>{" "}
        with 1,662 investors. Both are screened for sector fit, deal size and
        recent activity. I left off the current owner and two investors whose
        matching deals were clearly wrong.
      </p>

      <h3 className="pt-2 font-semibold">Strategic buyers</h3>
      <ul className="list-disc space-y-2 pl-6 marker:text-ink">
        <li>
          <span className="font-semibold">Large software platforms:</span>{" "}
          <Co>Nordwind Software</Co>, <Co>Helix Systems</Co>,{" "}
          <Co>Corvane Technologies</Co> and <Co>Atlas Cloud</Co>.
          <ul className="mt-2 list-disc pl-6">
            <li>
              <Co>Helix Systems</Co> bought <Co>Brightline Labs</Co> in 2024, a
              direct precedent.
            </li>
          </ul>
        </li>
        <li>
          <span className="font-semibold">Mid-market consolidators:</span>{" "}
          <Co>Kestrel Group</Co>, <Co>Solano Digital</Co> and{" "}
          <Co>Quorum Platforms</Co>.
        </li>
      </ul>

      <h3 className="pt-2 font-semibold">Financial buyers</h3>
      <ul className="list-disc space-y-2 pl-6 marker:text-ink">
        <li>
          <span className="font-semibold">
            Software-focused private equity:
          </span>{" "}
          <Co>Alpine Peak Capital</Co>, <Co>Lakeview Equity Partners</Co> and{" "}
          <Co>Granite Growth Partners</Co>.
        </li>
        <li>
          <span className="font-semibold">Growth equity:</span>{" "}
          <Co>Northgate Growth Partners</Co> and <Co>Ridgeway Capital</Co>.
        </li>
      </ul>

      <p>
        Want me to narrow either list by geography or deal size, or draft
        outreach for the top 20?
      </p>
    </div>
  );
}
