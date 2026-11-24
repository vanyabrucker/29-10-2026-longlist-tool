"use client";

import { AnimatePresence, motion } from "motion/react";
import { useCallback, useRef, useState, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Calendar, ChevronLeft, ChevronRight } from "@/components/icons";
import { useI18n } from "@/lib/i18n";
import { useAnchor, useEscape, useOutside } from "./Select";

const CALENDAR_HEIGHT = 340;

/** "2026-11-24" ↔ "24.11.2026": the field shows days first, as in
 * Switzerland, in both languages. */
const pad = (n: number) => String(n).padStart(2, "0");
const toIso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
export const showDate = (iso: string) => {
  const [y, m, d] = iso.split("-");
  return y && m && d ? `${d}.${m}.${y}` : "";
};

/** What the field accepts: 24.11.2026, 24/11/2026, 24-11-2026, a two-digit
 * year (24.11.26 = 2026), or ISO 2026-11-24. Null for anything else or a
 * day that doesn't exist (31.02.). */
export function parseDate(text: string): string | null {
  const s = text.trim();
  let y: number, m: number, d: number;
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s);
  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{2}|\d{4})$/.exec(s);
  if (iso) [y, m, d] = [+iso[1], +iso[2], +iso[3]];
  else if (dmy) {
    [d, m, y] = [+dmy[1], +dmy[2], +dmy[3]];
    if (dmy[3].length === 2) y += 2000;
  } else return null;
  const date = new Date(y, m - 1, d);
  if (
    date.getFullYear() !== y ||
    date.getMonth() !== m - 1 ||
    date.getDate() !== d
  )
    return null;
  return toIso(y, m, d);
}

const today = () => {
  const n = new Date();
  return toIso(n.getFullYear(), n.getMonth() + 1, n.getDate());
};

/** A date you can type (days first) or pick from a calendar: month arrows,
 * the title opens a year grid, and "Today". Saves on Enter, blur or a pick;
 * an invalid date isn't saved and the field says so. */
export function DateField({
  value,
  onChange,
  label,
  className = "",
}: {
  /** ISO date, or "" for none. */
  value: string;
  onChange: (iso: string) => void;
  label: string;
  className?: string;
}) {
  const { t, lang } = useI18n();
  const [text, setText] = useState(showDate(value));
  const [invalid, setInvalid] = useState(false);
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  const pos = useAnchor(box, open, CALENDAR_HEIGHT);
  const close = useCallback(() => setOpen(false), []);
  useOutside(box, popover, open, close);
  useEscape(open, close);

  // A new value from outside (saved, or another import) replaces the text.
  const [shown, setShown] = useState(value);
  if (value !== shown) {
    setShown(value);
    setText(showDate(value));
    setInvalid(false);
  }

  function commit() {
    if (!text.trim()) {
      setText(showDate(value));
      setInvalid(false);
      return;
    }
    const iso = parseDate(text);
    setInvalid(!iso);
    if (!iso) return;
    setText(showDate(iso));
    if (iso !== value) onChange(iso);
  }
  function pick(iso: string) {
    setOpen(false);
    setText(showDate(iso));
    setInvalid(false);
    input.current?.focus();
    if (iso !== value) onChange(iso);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
    } else if (e.key === "Escape") {
      // Stop here, so a modal around the field stays open.
      e.stopPropagation();
      if (open) setOpen(false);
      else {
        setText(showDate(value));
        setInvalid(false);
      }
    } else if (e.key === "ArrowDown" && e.altKey) {
      e.preventDefault();
      setOpen(true);
    }
  }

  return (
    <>
      <div
        ref={box}
        className={`flex h-9 items-center rounded-lg border bg-white pr-1 text-[13.5px] transition-shadow focus-within:ring-3 ${invalid ? "border-[#c9d9ef] ring-3 ring-sky" : "border-line focus-within:border-[#c9d9ef] focus-within:ring-sky"} ${className}`}
      >
        <input
          ref={input}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            if (invalid) setInvalid(false);
          }}
          onBlur={(e) => {
            // Moving into the calendar isn't leaving the field.
            if (popover.current?.contains(e.relatedTarget as Node)) return;
            commit();
          }}
          onKeyDown={onKey}
          placeholder={t("dd.mm.yyyy")}
          aria-label={label}
          aria-invalid={invalid}
          inputMode="numeric"
          className="h-full min-w-0 flex-1 bg-transparent pl-2.5 text-ink tabular-nums outline-none placeholder:text-faint"
        />
        <button
          type="button"
          aria-label={t("Pick a date")}
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
          className={`flex size-7 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:bg-subtle hover:text-ink ${open ? "bg-subtle text-ink" : ""}`}
        >
          <Calendar size={15} strokeWidth={1.75} />
        </button>
      </div>
      {invalid && (
        <span role="alert" className="sr-only">
          {t("Not a valid date")}
        </span>
      )}
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {open && pos && (
              <motion.div
                ref={popover}
                initial={{ opacity: 0, scale: 0.97, y: pos.top ? -4 : 4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{
                  opacity: 0,
                  scale: 0.97,
                  transition: { duration: 0.1 },
                }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                style={{ left: pos.left, top: pos.top, bottom: pos.bottom }}
                className={`fixed z-[90] w-[268px] rounded-xl border border-line bg-white p-2 shadow-[0_4px_20px_rgba(0,0,0,0.08)] ${pos.top ? "origin-top" : "origin-bottom"}`}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    e.stopPropagation();
                    setOpen(false);
                    input.current?.focus();
                  }
                }}
              >
                <Month
                  selected={parseDate(text) ?? value}
                  lang={lang}
                  onPick={pick}
                />
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}

/** The calendar: a month of days (weeks start on Monday), or a grid of
 * twelve years when the title is clicked. */
function Month({
  selected,
  lang,
  onPick,
}: {
  selected: string;
  lang: string;
  onPick: (iso: string) => void;
}) {
  const { t } = useI18n();
  const locale = lang === "de" ? "de-CH" : "en-GB";
  const start = selected || today();
  const [year, setYear] = useState(+start.slice(0, 4));
  const [month, setMonth] = useState(+start.slice(5, 7)); // 1–12
  const [years, setYears] = useState(false);

  const title = new Intl.DateTimeFormat(locale, {
    month: "long",
    year: "numeric",
  }).format(new Date(year, month - 1, 1));
  const weekdays = Array.from({ length: 7 }, (_, i) =>
    new Intl.DateTimeFormat(locale, { weekday: "short" })
      .format(new Date(2024, 0, 1 + i)) // 1 Jan 2024 was a Monday
      .slice(0, 2),
  );
  const first = (new Date(year, month - 1, 1).getDay() + 6) % 7; // Monday = 0
  const days = new Date(year, month, 0).getDate();
  const cells: (number | null)[] = [
    ...Array<null>(first).fill(null),
    ...Array.from({ length: days }, (_, i) => i + 1),
  ];
  const now = today();

  function step(delta: number) {
    if (years) {
      setYear((y) => y + delta * 12);
      return;
    }
    const m = month + delta;
    setMonth(((m - 1 + 12) % 12) + 1);
    setYear((y) => y + Math.floor((m - 1) / 12));
  }
  const firstYear = year - (year % 12);
  const nav =
    "flex size-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-subtle hover:text-ink";

  return (
    <div className="text-[13px]">
      <div className="mb-1.5 flex items-center justify-between">
        <button
          type="button"
          aria-label={years ? t("Earlier years") : t("Previous month")}
          onClick={() => step(-1)}
          className={nav}
        >
          <ChevronLeft size={15} strokeWidth={1.75} />
        </button>
        <button
          type="button"
          aria-label={years ? t("Back to the days") : t("Choose a year")}
          onClick={() => setYears((v) => !v)}
          className="h-8 rounded-full px-3 font-medium text-ink transition-colors hover:bg-subtle"
        >
          {years ? `${firstYear}–${firstYear + 11}` : title}
        </button>
        <button
          type="button"
          aria-label={years ? t("Later years") : t("Next month")}
          onClick={() => step(1)}
          className={nav}
        >
          <ChevronRight size={15} strokeWidth={1.75} />
        </button>
      </div>

      {years ? (
        <div className="grid grid-cols-3 gap-1">
          {Array.from({ length: 12 }, (_, i) => firstYear + i).map((y) => (
            <button
              key={y}
              type="button"
              onClick={() => {
                setYear(y);
                setYears(false);
              }}
              className={`h-9 rounded-lg tabular-nums transition-colors ${y === +start.slice(0, 4) ? "bg-ink text-white" : "hover:bg-subtle"}`}
            >
              {y}
            </button>
          ))}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-7 text-center text-[11.5px] text-faint">
            {weekdays.map((w) => (
              <span key={w} className="py-1">
                {w}
              </span>
            ))}
          </div>
          <div className="grid grid-cols-7 gap-y-0.5">
            {cells.map((d, i) => {
              if (d === null) return <span key={`e${i}`} />;
              const iso = toIso(year, month, d);
              const isSel = iso === selected;
              return (
                <button
                  key={iso}
                  type="button"
                  onClick={() => onPick(iso)}
                  aria-pressed={isSel}
                  className={`mx-auto flex size-8 items-center justify-center rounded-full tabular-nums transition-colors ${isSel ? "bg-ink text-white" : iso === now ? "font-medium text-sky-ink hover:bg-subtle" : "hover:bg-subtle"}`}
                >
                  {d}
                </button>
              );
            })}
          </div>
        </>
      )}

      <div className="mt-2 flex justify-end border-t border-hairline pt-2">
        <button
          type="button"
          onClick={() => onPick(now)}
          className="h-7 rounded-full px-3 text-[12.5px] text-muted transition-colors hover:bg-subtle hover:text-ink"
        >
          {t("Today")}
        </button>
      </div>
    </div>
  );
}
