"use client";

import { AnimatePresence, motion, useAnimate } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { Maximize2, Minimize2, Table } from "react-feather";
import { gw } from "@/lib/gateway";
import { useI18n } from "@/lib/i18n";
import type { LonglistSummary } from "@/lib/longlists";
import { LonglistDetail } from "./LonglistTable";

const EASE = [0.32, 0.72, 0, 1] as const;

/** The research column: the chat's longlists as tabs (green sheet icon on
 * the open one), a full-screen button, and the open list's table. */
export function SessionListPanel({
  listIds,
  activeId,
  onActiveChange,
}: {
  listIds: string[];
  activeId: string;
  onActiveChange: (id: string) => void;
}) {
  const { t } = useI18n();
  const [summaries, setSummaries] = useState<LonglistSummary[]>([]);
  const { scope, slotRef, fixedFrom, expanded, toggleFullscreen } =
    useFullscreen();
  const key = listIds.join(",");

  useEffect(() => {
    let live = true;
    gw<LonglistSummary[]>("/longlists").then(
      (all) =>
        live && setSummaries(all.filter((l) => key.split(",").includes(l.id))),
      () => {},
    );
    return () => {
      live = false;
    };
  }, [key]);

  return (
    <>
      {/* Holds the panel's place in the layout while it's lifted out full screen. */}
      {fixedFrom && <div ref={slotRef} className="my-3 mr-3 min-w-0 flex-1" />}
      <motion.section
        ref={scope}
        initial={{ opacity: 0, x: 48 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 48 }}
        transition={{ duration: 0.6, ease: EASE, delay: 0.15 }}
        style={
          fixedFrom
            ? { position: "fixed", zIndex: 50, ...fixedFrom }
            : undefined
        }
        className={`relative flex min-w-0 flex-col overflow-hidden rounded-xl border border-line bg-white ${fixedFrom ? "" : "my-3 mr-3 flex-1"}`}
      >
        <div className="flex h-8 shrink-0 items-stretch border-b border-line bg-canvas">
          <div className="flex min-w-0 items-stretch overflow-x-auto">
            {listIds.map((id) => {
              const active = id === activeId;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onActiveChange(id)}
                  className={`relative -mb-px flex shrink-0 items-center gap-2 border-r border-line px-3 text-[13.5px] transition-colors ${
                    active ? "bg-white text-ink" : "text-muted hover:text-ink"
                  }`}
                >
                  <Table
                    size={13}
                    strokeWidth={1.75}
                    className={active ? "text-sheet" : "text-faint"}
                  />
                  {summaries.find((s) => s.id === id)?.name ?? "…"}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            onClick={toggleFullscreen}
            aria-label={expanded ? t("Exit full screen") : t("Full screen")}
            className="ml-auto flex w-9 shrink-0 items-center justify-center text-[#5d5d63] transition-colors hover:text-ink"
          >
            {expanded ? (
              <Minimize2 size={14} strokeWidth={1.75} />
            ) : (
              <Maximize2 size={14} strokeWidth={1.75} />
            )}
          </button>
        </div>
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={activeId}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="flex min-h-0 flex-1 flex-col"
          >
            <LonglistDetail id={activeId} variant="panel" />
          </motion.div>
        </AnimatePresence>
      </motion.section>
    </>
  );
}

type Rect = { top: number; left: number; width: number; height: number };

const rectOf = (el: Element): Rect => {
  const { top, left, width, height } = el.getBoundingClientRect();
  return { top, left, width, height };
};

// Lifts the panel out of the layout into a fixed layer and grows it from its
// box to the whole window (over the header and sidebar), animating
// top/left/width/height so the content reflows instead of being scaled.
// Escape or the button returns it to its slot.
function useFullscreen() {
  const [scope, animate] = useAnimate<HTMLElement>();
  const slotRef = useRef<HTMLDivElement>(null);
  const [fixedFrom, setFixedFrom] = useState<Rect | null>(null);
  const [expanded, setExpanded] = useState(false);
  const busy = useRef(false);

  const toggleFullscreen = useCallback(async () => {
    const el = scope.current;
    if (!el || busy.current) return;
    busy.current = true;
    const transition = { duration: 0.5, ease: EASE };
    if (!expanded) {
      flushSync(() => {
        setFixedFrom(rectOf(el));
        setExpanded(true);
      });
      await animate(
        el,
        {
          top: 0,
          left: 0,
          width: window.innerWidth,
          height: window.innerHeight,
          borderRadius: 0,
        },
        transition,
      );
      // Track the window from here on, so resizing while full screen works.
      Object.assign(el.style, { width: "100vw", height: "100vh" });
    } else {
      setExpanded(false);
      Object.assign(el.style, {
        width: `${window.innerWidth}px`,
        height: `${window.innerHeight}px`,
      });
      const slot = slotRef.current;
      if (slot)
        await animate(el, { ...rectOf(slot), borderRadius: 12 }, transition);
      flushSync(() => setFixedFrom(null));
      Object.assign(el.style, { top: "", left: "", width: "", height: "" });
    }
    busy.current = false;
  }, [animate, expanded, scope]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && toggleFullscreen();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded, toggleFullscreen]);

  return { scope, slotRef, fixedFrom, expanded, toggleFullscreen };
}
