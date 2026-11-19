"use client";

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, Database, Globe } from "react-feather";
import { useI18n } from "@/lib/i18n";

// Citations in agent-written text: `[[source | url | evidence]]` (the
// gateway's `app/citations.py` checks the same syntax). Each one shows as a
// small numbered chip; hovering it opens the source and the evidence. The
// source is a person or a data provider for internal data; a url means a web
// page, shown as "Web research" and the site's address.

export type Cite = { source: string; url: string; evidence: string };
export type CitedPart =
  { kind: "text"; text: string } | { kind: "cite"; n: number; cite: Cite };

const MARKER = /\[\[([\s\S]*?)\]\]/g;

function parseMarker(body: string): Cite | null {
  const parts = body.split("|");
  if (parts.length < 3) return null;
  const source = parts[0].trim();
  const url = parts[1].trim();
  const evidence = parts.slice(2).join("|").trim();
  if (!source || !evidence) return null;
  if (url && !/^https?:\/\/\S+$/.test(url)) return null;
  return { source, url, evidence };
}

/** Text with its markers cut out, numbered in order (the same citation
 * twice keeps one number). A marker that doesn't parse stays as text. */
export function parseCited(text: string): CitedPart[] {
  const parts: CitedPart[] = [];
  const numbers = new Map<string, number>();
  let last = 0;
  for (const m of text.matchAll(MARKER)) {
    const cite = parseMarker(m[1]);
    if (!cite) continue;
    // The chip sits against the word, so a space before the marker goes.
    const before = text.slice(last, m.index).replace(/[ \t]+$/, "");
    if (before) parts.push({ kind: "text", text: before });
    const key = `${cite.source}|${cite.url}|${cite.evidence}`;
    if (!numbers.has(key)) numbers.set(key, numbers.size + 1);
    parts.push({ kind: "cite", n: numbers.get(key)!, cite });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ kind: "text", text: text.slice(last) });
  return parts;
}

export const hasCites = (text: string) => text.includes("[[");

/** Text as it streams: a marker still being written is held back. */
export function withoutOpenCite(text: string): string {
  const open = text.lastIndexOf("[[");
  return open !== -1 && text.indexOf("]]", open) === -1
    ? text.slice(0, open)
    : text;
}

/** Plain text for copying: markers removed, spacing before punctuation fixed. */
export function stripCites(text: string): string {
  return hasCites(text)
    ? parseCited(text)
        .map((p) => (p.kind === "text" ? p.text : ""))
        .join("")
        .replace(/[ \t]+([.,;:])/g, "$1")
    : text;
}

/** Plain text with chips, for table cells and streaming messages. */
export function CitedText({ text }: { text: string }) {
  if (!hasCites(text)) return <>{text}</>;
  return (
    <>
      {parseCited(text).map((p, i) =>
        p.kind === "text" ? (
          <Fragment key={i}>{p.text}</Fragment>
        ) : (
          <CitationChip key={i} n={p.n} cite={p.cite} />
        ),
      )}
    </>
  );
}

function host(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

const POPOVER_WIDTH = 360;

/** The numbered chip. Hover or focus opens the source and its evidence; a
 * click toggles it (touch). The popover is in a portal, so tables and
 * scrolling panes can't clip it. */
export function CitationChip({ n, cite }: { n: number; cite: Cite }) {
  const { t } = useI18n();
  const chipRef = useRef<HTMLSpanElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [pos, setPos] = useState<{
    left: number;
    top: number;
    above: boolean;
  } | null>(null);

  const open = useCallback(() => {
    clearTimeout(timer.current);
    const el = chipRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(
      8,
      Math.min(
        r.left + r.width / 2 - POPOVER_WIDTH / 2,
        window.innerWidth - POPOVER_WIDTH - 8,
      ),
    );
    const above = r.top > window.innerHeight / 2;
    setPos({ left, top: above ? r.top - 8 : r.bottom + 8, above });
  }, []);
  const closeSoon = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setPos(null), 120);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => {
    if (!pos) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setPos(null);
    const onScroll = () => setPos(null);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [pos]);

  const web = cite.url !== "";
  const header = (
    <>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-white/10">
        {web ? (
          <Globe size={15} strokeWidth={1.75} />
        ) : (
          <Database size={15} strokeWidth={1.75} />
        )}
      </span>
      <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
        {web ? t("Web research") : cite.source}
        {web && (
          <span className="pl-2 font-normal text-white/60">
            {host(cite.url)}
          </span>
        )}
      </span>
      {web && (
        <ArrowUpRight
          size={16}
          strokeWidth={1.75}
          className="shrink-0 text-white/70"
        />
      )}
    </>
  );

  return (
    <>
      <span
        ref={chipRef}
        role="button"
        tabIndex={0}
        aria-label={t("Source {n}", { n: String(n) })}
        onMouseEnter={open}
        onMouseLeave={closeSoon}
        onFocus={open}
        onBlur={closeSoon}
        onClick={(e) => {
          e.stopPropagation();
          if (pos) setPos(null);
          else open();
        }}
        onDoubleClick={(e) => e.stopPropagation()}
        className="mx-[3px] inline-flex size-[18px] cursor-pointer items-center justify-center rounded-full bg-subtle align-[1px] text-[11px] leading-none font-medium text-muted tabular-nums transition-colors select-none hover:bg-line hover:text-ink"
      >
        {n}
      </span>
      {pos &&
        createPortal(
          <div
            role="tooltip"
            onMouseEnter={open}
            onMouseLeave={closeSoon}
            onClick={(e) => e.stopPropagation()}
            style={{
              left: pos.left,
              top: pos.top,
              width: POPOVER_WIDTH,
              transform: pos.above ? "translateY(-100%)" : undefined,
            }}
            className="fixed z-[90] animate-[row-in_0.12s_ease-out] overflow-hidden rounded-2xl bg-ink text-white shadow-[0_8px_28px_rgba(0,0,0,0.22)]"
          >
            {web ? (
              <a
                href={cite.url}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-3 bg-white/[0.09] px-4 py-3 transition-colors hover:bg-white/[0.14]"
              >
                {header}
              </a>
            ) : (
              <div className="flex items-center gap-3 bg-white/[0.09] px-4 py-3">
                {header}
              </div>
            )}
            <p className="max-h-60 overflow-y-auto px-5 py-4 text-[13.5px] leading-[1.6] break-words whitespace-normal text-white/90">
              {cite.evidence}
            </p>
          </div>,
          document.body,
        )}
    </>
  );
}
