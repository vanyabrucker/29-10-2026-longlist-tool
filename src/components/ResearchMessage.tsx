"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Check, ChevronRight } from "react-feather";
import type { Message, Research } from "@/lib/chat";
import { RESEARCH_STEPS, type BuyerList } from "@/lib/research";
import { INTAKE_STEPS, listsPhrase } from "@/lib/scoping";
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

type Step = { at: number; label: string };

// "Working… Ns" with the steps reached so far; once done, a collapsible
// "Worked for Ns" that reveals them again.
function WorkLog({
  message,
  steps,
  progress,
}: {
  message: Message;
  steps: Step[];
  progress: number;
}) {
  const running = message.status === "researching";
  const now = useNow(running);
  const [stepsOpen, setStepsOpen] = useState(false);
  const elapsed = (message.finishedAt ?? now) - (message.startedAt ?? now);
  const reached = steps.filter((s) => s.at <= progress);

  return (
    <>
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
          // Height animates on the wrapper so the bordered box collapses cleanly.
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.3, ease: EASE }}
            className="overflow-hidden"
          >
            <ul className="mt-2.5 space-y-2 rounded-xl border border-line px-3 py-2.5">
              {reached.map((s, i) => {
                const current = running && i === reached.length - 1;
                return (
                  <motion.li
                    key={s.label}
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.3, ease: EASE }}
                    className={`flex items-center gap-2 text-[13.5px] ${current ? "text-ink" : "text-muted"}`}
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
            </ul>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}

function Revealed({ children }: { children: React.ReactNode }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.45, ease: EASE, delay: 0.1 }}
    >
      {children}
    </motion.div>
  );
}

/** First reply: profiles the company, then the scoping questions take over. */
export function IntakeMessage({ message }: { message: Message }) {
  if (message.status === "thinking") return <ThinkingGrid />;
  const done = message.status === "done";
  return (
    <div>
      <WorkLog
        message={message}
        steps={INTAKE_STEPS}
        progress={done ? 1 : (message.progress ?? 0)}
      />
      {done && (
        <Revealed>
          {/* Rich version of INTAKE_TEXT (lib/scoping.ts); keep in sync. */}
          <div className="mt-4 space-y-4 text-[15px] leading-[1.7]">
            <p>I&apos;ve profiled the company and its market:</p>
            <ul className="list-disc space-y-2 pl-6 marker:text-ink">
              <li>
                <span className="font-semibold">Sector:</span> B2B software for
                industrial asset management, mostly recurring revenue.
              </li>
              <li>
                <span className="font-semibold">Peers:</span> 14 comparable
                companies, 9 of them acquired in the last five years.
              </li>
              <li>
                <span className="font-semibold">Deal activity:</span> steady
                consolidation by software platforms and growth investors since
                2023.
              </li>
            </ul>
            <p>Three quick questions to scope the buyer universe.</p>
          </div>
          <div className="mt-2">
            <CopyButton text={message.content} />
          </div>
        </Revealed>
      )}
    </div>
  );
}

export function ResearchMessage({
  message,
  research,
  geography,
  onOpenList,
}: {
  message: Message;
  research?: Research;
  /** First scoping answer; shapes the summary's wording. */
  geography?: string;
  onOpenList: (id: BuyerList["id"]) => void;
}) {
  if (message.status === "thinking") return <ThinkingGrid />;
  const done = message.status === "done";

  return (
    <div>
      <WorkLog
        message={message}
        steps={RESEARCH_STEPS}
        progress={done ? 1 : (research?.progress ?? 0)}
      />
      {done && (
        <Revealed>
          <Summary geography={geography} onOpenList={onOpenList} />
          <div className="mt-2">
            <CopyButton text={message.content} />
          </div>
        </Revealed>
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

// Rich version of researchSummaryText (lib/chat.tsx); keep the two in sync.
function Summary({
  geography,
  onOpenList,
}: {
  geography?: string;
  onOpenList: OpenList;
}) {
  return (
    <div className="mt-4 space-y-4 text-[15px] leading-[1.7]">
      <p>
        I&apos;ve built {listsPhrase(geography)}:{" "}
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
