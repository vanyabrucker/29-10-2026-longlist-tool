"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown, Search } from "@/components/icons";

export type SelectOption = {
  value: string;
  label: string;
  /** Faint text at the right of the row, e.g. a confidence ("95%"). */
  hint?: string;
  /** A hairline above this row, to set a group apart. */
  divider?: boolean;
  /** A heading shown above the first row of each group (consecutive rows). */
  group?: string;
};

/** The trigger's look; matches the inputs next to it. */
export const SELECT_TRIGGER =
  "flex h-9 items-center justify-between gap-2 rounded-lg border border-line bg-white pr-2 pl-2.5 text-left text-[13.5px] text-ink outline-none transition-colors hover:bg-subtle focus-visible:border-[#c9d9ef] focus-visible:ring-3 focus-visible:ring-sky";

const POPOVER =
  "fixed z-[90] overflow-y-auto rounded-xl border border-line bg-white p-1 shadow-[0_4px_20px_rgba(0,0,0,0.08)]";
const MAX_HEIGHT = 360;
const GAP = 6;

/** Where a popover sits: under its trigger, or above it when the window
 * has no room below. Kept in place while anything scrolls. */
export function useAnchor(
  anchor: RefObject<HTMLElement | null>,
  open: boolean,
  height: number,
) {
  const [pos, setPos] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  } | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const r = anchor.current?.getBoundingClientRect();
      if (!r) return;
      const below = window.innerHeight - r.bottom;
      setPos(
        below >= height + GAP || below >= r.top
          ? { left: r.left, width: r.width, top: r.bottom + GAP }
          : {
              left: r.left,
              width: r.width,
              bottom: window.innerHeight - r.top + GAP,
            },
      );
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [anchor, open, height]);
  return pos;
}

/** Closes on a pointer press outside both the trigger and its portal. */
export function useOutside(
  a: RefObject<HTMLElement | null>,
  b: RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
) {
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!a.current?.contains(t) && !b.current?.contains(t)) close();
    };
    document.addEventListener("pointerdown", onPointer);
    return () => document.removeEventListener("pointerdown", onPointer);
  }, [a, b, open, close]);
}

/** While `open`, Escape closes the popover and goes no further: handled on
 * the window in the capture phase, before a modal's own Escape listener,
 * wherever the focus is. */
export function useEscape(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, close]);
}

type Key = { key: string; preventDefault(): void; stopPropagation(): void };

/** A custom dropdown in the app's popover style (36px rows, check on the
 * right, optional group headings). Keyboard: arrows, Home/End, Enter (or
 * Space) to pick, Escape to close without closing a modal around it; a
 * letter jumps to the next option starting with it, or, with `searchable`,
 * types into a filter at the top of the list. The list is a portal, so a
 * scrolling modal doesn't clip it. */
export function Select({
  value,
  options,
  onChange,
  label,
  className = "",
  renderValue,
  searchable = false,
  searchPlaceholder = "",
  noMatches = "",
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  /** The field's name, for screen readers. */
  label: string;
  className?: string;
  renderValue?: (option: SelectOption | undefined) => ReactNode;
  searchable?: boolean;
  searchPlaceholder?: string;
  /** Shown when the filter matches nothing. */
  noMatches?: string;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [query, setQuery] = useState("");
  const trigger = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);

  const needle = fold(query.trim());
  const shown = needle
    ? options.filter((o) => fold(o.label).includes(needle))
    : options;
  const groups = new Set(shown.map((o) => o.group).filter(Boolean)).size;
  const pos = useAnchor(
    trigger,
    open,
    Math.min(
      MAX_HEIGHT,
      shown.length * 36 + groups * 28 + (searchable ? 44 : 0) + 8,
    ),
  );

  const close = useCallback(() => setOpen(false), []);
  useOutside(trigger, list, open, close);

  function show() {
    setQuery("");
    setActive(
      Math.max(
        0,
        options.findIndex((o) => o.value === value),
      ),
    );
    setOpen(true);
  }
  function pick(i: number) {
    const o = shown[i];
    if (!o) return;
    setOpen(false);
    trigger.current?.focus();
    if (o.value !== value) onChange(o.value);
  }

  // Focus the filter once the list is there.
  const placed = pos !== null;
  useEffect(() => {
    if (open && placed && searchable) search.current?.focus();
  }, [open, placed, searchable]);

  // Keep the highlighted row in view.
  useEffect(() => {
    if (!open) return;
    list.current
      ?.querySelector<HTMLElement>(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  function onKey(e: Key) {
    if (!open) {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) {
        e.preventDefault();
        show();
      }
      return;
    }
    const last = shown.length - 1;
    if (e.key === "Tab") {
      setOpen(false);
      return;
    }
    const typing =
      searchable &&
      (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete");
    // Letters go to the filter; every other key is the list's while open.
    if (typing) return;
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(last, a + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === "Home" && !searchable) {
      e.preventDefault();
      setActive(0);
    } else if (e.key === "End" && !searchable) {
      e.preventDefault();
      setActive(last);
    } else if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      pick(active);
    } else if (e.key.length === 1 && /\S/.test(e.key)) {
      const ch = e.key.toLowerCase();
      const order = [...shown.slice(active + 1), ...shown.slice(0, active + 1)];
      const hit = order.find((o) => o.label.toLowerCase().startsWith(ch));
      if (hit) setActive(shown.indexOf(hit));
    }
  }

  // While open, keys reach the list wherever the focus is (a click may not
  // leave it on the trigger), before a modal's own listeners.
  const keyRef = useRef(onKey);
  useLayoutEffect(() => {
    keyRef.current = onKey;
  });
  useEffect(() => {
    if (!open) return;
    const handle = (e: globalThis.KeyboardEvent) => keyRef.current(e);
    window.addEventListener("keydown", handle, true);
    return () => window.removeEventListener("keydown", handle, true);
  }, [open]);

  const current = options.find((o) => o.value === value);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? `${id}-list` : undefined}
        aria-activedescendant={
          open && shown[active] ? `${id}-${active}` : undefined
        }
        aria-label={`${label}: ${current?.label ?? ""}`}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
        className={`${SELECT_TRIGGER} ${open ? "bg-subtle" : ""} ${className}`}
      >
        <span className="min-w-0 truncate">
          {renderValue ? renderValue(current) : (current?.label ?? "")}
        </span>
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className={`shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {typeof document !== "undefined" &&
        createPortal(
          <AnimatePresence>
            {open && pos && (
              <motion.div
                ref={list}
                initial={{ opacity: 0, scale: 0.97, y: pos.top ? -4 : 4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{
                  opacity: 0,
                  scale: 0.97,
                  transition: { duration: 0.1 },
                }}
                transition={{ duration: 0.15, ease: "easeOut" }}
                style={{
                  left: pos.left,
                  top: pos.top,
                  bottom: pos.bottom,
                  minWidth: pos.width,
                  maxHeight: MAX_HEIGHT,
                }}
                className={`${POPOVER} flex flex-col overflow-hidden ${pos.top ? "origin-top" : "origin-bottom"}`}
              >
                {searchable && (
                  <div className="mb-1 flex h-9 shrink-0 items-center gap-2 border-b border-hairline px-2.5">
                    <Search
                      size={14}
                      strokeWidth={1.75}
                      className="shrink-0 text-faint"
                    />
                    <input
                      ref={search}
                      value={query}
                      onChange={(e) => {
                        setQuery(e.target.value);
                        setActive(0);
                      }}
                      placeholder={searchPlaceholder}
                      aria-label={searchPlaceholder || label}
                      aria-controls={`${id}-list`}
                      className="h-full min-w-0 flex-1 bg-transparent text-[13.5px] text-ink outline-none placeholder:text-faint"
                    />
                  </div>
                )}
                <div
                  id={`${id}-list`}
                  role="listbox"
                  aria-label={label}
                  className="min-h-0 overflow-y-auto"
                >
                  {shown.length === 0 && (
                    <p className="flex h-9 items-center px-2.5 text-[13px] text-muted">
                      {noMatches}
                    </p>
                  )}
                  {shown.map((o, i) => {
                    const heading =
                      o.group && o.group !== shown[i - 1]?.group
                        ? o.group
                        : null;
                    return (
                      <div key={o.value}>
                        {o.divider && i > 0 && !heading && (
                          <div className="mx-1 my-1 h-px bg-hairline" />
                        )}
                        {heading && (
                          <div
                            role="presentation"
                            className={`flex h-7 items-end px-2.5 pb-1 text-[11.5px] font-medium text-faint ${i > 0 ? "mt-1 border-t border-hairline" : ""}`}
                          >
                            {heading}
                          </div>
                        )}
                        <div
                          id={`${id}-${i}`}
                          data-index={i}
                          role="option"
                          aria-selected={o.value === value}
                          onPointerMove={() => setActive(i)}
                          onClick={() => pick(i)}
                          className={`flex h-9 cursor-pointer items-center gap-3 rounded-lg px-2.5 text-[13.5px] whitespace-nowrap ${i === active ? "bg-subtle" : ""}`}
                        >
                          <span className="min-w-0 flex-1 truncate">
                            {o.label}
                          </span>
                          {o.hint && (
                            <span className="text-[12.5px] text-faint tabular-nums">
                              {o.hint}
                            </span>
                          )}
                          <Check
                            size={15}
                            strokeWidth={2}
                            className={`shrink-0 ${o.value === value ? "" : "invisible"}`}
                          />
                        </div>
                      </div>
                    );
                  })}
                </div>
              </motion.div>
            )}
          </AnimatePresence>,
          document.body,
        )}
    </>
  );
}

/** Lower case without accents, so "zuerich" finds nothing but "zurich"
 * finds "Zürich". */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
