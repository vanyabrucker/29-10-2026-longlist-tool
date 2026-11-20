"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

const DELAY_MS = 150;
/** Gap between the tooltip and its element, and the least distance it keeps
 * from the window's edges. */
const GAP = 6;
const EDGE = 8;

/** A black tooltip above its parent element, shown on hover after a short
 * delay. Rendered in a portal at a fixed position, so cards with
 * `overflow-hidden` and popovers can't clip it; kept inside the window. */
export function HoverTooltip({ label }: { label: string }) {
  const anchor = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const [left, setLeft] = useState<number | null>(null);

  useEffect(() => {
    const target = anchor.current?.parentElement;
    if (!target) return;
    let timer: number | undefined;
    const show = () => {
      timer = window.setTimeout(
        () => setRect(target.getBoundingClientRect()),
        DELAY_MS,
      );
    };
    const hide = () => {
      window.clearTimeout(timer);
      setRect(null);
      setLeft(null);
    };
    target.addEventListener("mouseenter", show);
    target.addEventListener("mouseleave", hide);
    window.addEventListener("scroll", hide, true);
    return () => {
      window.clearTimeout(timer);
      target.removeEventListener("mouseenter", show);
      target.removeEventListener("mouseleave", hide);
      window.removeEventListener("scroll", hide, true);
    };
  }, []);

  // Centre on the element, then nudge it back inside the window.
  useEffect(() => {
    if (!rect || !tip.current) return;
    const width = tip.current.offsetWidth;
    const centred = rect.left + rect.width / 2 - width / 2;
    const max = window.innerWidth - EDGE - width;
    setLeft(Math.max(EDGE, Math.min(centred, max)));
  }, [rect, label]);

  return (
    <span ref={anchor} hidden>
      {rect &&
        createPortal(
          <span
            ref={tip}
            role="tooltip"
            style={{
              left: left ?? rect.left,
              top: rect.top - GAP,
              visibility: left === null ? "hidden" : "visible",
            }}
            className="pointer-events-none fixed z-[90] -translate-y-full rounded-md bg-ink px-2 py-1 text-[12px] leading-[14px] font-medium whitespace-nowrap text-white"
          >
            {label}
          </span>,
          document.body,
        )}
    </span>
  );
}
