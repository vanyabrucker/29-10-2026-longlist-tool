"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Check, ChevronRight } from "react-feather";
import type { Message, Research } from "@/lib/chat";
import { RESEARCH_STEPS, type BuyerList } from "@/lib/research";
import { INTAKE, INTAKE_STEPS, listsPhrase } from "@/lib/scoping";
import { useI18n } from "@/lib/i18n";
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
  const { t } = useI18n();
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
          <span>{t("Working… {time}", { time: formatDuration(elapsed) })}</span>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setStepsOpen((o) => !o)}
          aria-expanded={stepsOpen}
          className="flex items-center gap-1 text-[14px] text-muted transition-colors hover:text-ink"
        >
          {t(message.stopped ? "Stopped after {time}" : "Worked for {time}", {
            time: formatDuration(elapsed),
          })}
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

/** A reply stopped before any of it arrived. */
export function StoppedNote() {
  const { t } = useI18n();
  return <div className="text-[14px] text-muted">{t("Stopped")}</div>;
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

/** First reply: reads the company, then profiles the buyers for both lists. */
export function IntakeMessage({ message }: { message: Message }) {
  if (message.status === "thinking") return <ThinkingGrid />;
  if (message.stopped && !message.startedAt) return <StoppedNote />;
  const done = message.status === "done";
  const stopped = message.stopped ?? false;
  return (
    <div>
      <WorkLog
        message={message}
        steps={INTAKE_STEPS}
        progress={done && !stopped ? 1 : (message.progress ?? 0)}
      />
      {done && !stopped && (
        <Revealed>
          <div className="mt-4 space-y-4 text-[15px] leading-[1.7]">
            <p>{INTAKE.intro}</p>
            {INTAKE.profiles.map((p) => (
              <div key={p.title}>
                <h3 className="pt-2 font-semibold">{p.title}</h3>
                <ul className="mt-2 list-disc space-y-2 pl-6 marker:text-ink">
                  {p.points.map((pt) => (
                    <li key={pt.label}>
                      <span className="font-semibold">{pt.label}:</span>{" "}
                      {pt.text}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            <p>{INTAKE.outro}</p>
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
  if (message.stopped && !message.startedAt) return <StoppedNote />;
  const done = message.status === "done";
  const stopped = message.stopped ?? false;

  return (
    <div>
      <WorkLog
        message={message}
        steps={RESEARCH_STEPS}
        progress={done && !stopped ? 1 : (research?.progress ?? 0)}
      />
      {done && !stopped && (
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
        with 1,662 investors. Strategics are screened for size, sector interest
        and financing capacity, investors for their published scope, ticket size
        and stage. Every buyer has a fit score from 0 to 100, and the lists are
        sorted by it.
      </p>

      <h3 className="pt-2 font-semibold">Strategic buyers</h3>
      <ul className="list-disc space-y-2 pl-6 marker:text-ink">
        <li>
          <span className="font-semibold">SAP consultancies:</span>{" "}
          <Co>Nordwind Business Consulting</Co> and{" "}
          <Co>Merkur Digital Consulting</Co>.
          <ul className="mt-2 list-disc pl-6">
            <li>
              <Co>Nordwind</Co> bought <Co>Corvane Logistics IT</Co>, an SAP
              supply chain boutique, in 2025, a direct precedent.
            </li>
          </ul>
        </li>
        <li>
          <span className="font-semibold">
            IT services and supply chain software:
          </span>{" "}
          <Co>Helix IT Services Group</Co> and{" "}
          <Co>Polaris Supply Chain Solutions</Co>.
        </li>
      </ul>

      <h3 className="pt-2 font-semibold">Financial buyers</h3>
      <ul className="list-disc space-y-2 pl-6 marker:text-ink">
        <li>
          <span className="font-semibold">
            Mittelstand and succession investors:
          </span>{" "}
          <Co>BWK</Co> and <Co>Neckar Mittelstand Beteiligungen</Co>.
          <ul className="mt-2 list-disc pl-6">
            <li>
              <Co>BWK</Co> takes majority stakes in established mid-sized
              companies and has backed engineering service firms.
            </li>
          </ul>
        </li>
        <li>
          <span className="font-semibold">IT services buy-and-build:</span>{" "}
          <Co>Isarblick Capital Partners</Co>, <Co>Rheintal Growth Partners</Co>{" "}
          and <Co>Kestrel Equity Partners</Co>.
        </li>
      </ul>

      <p>Want me to narrow either list, or draft outreach for the top 20?</p>
    </div>
  );
}
