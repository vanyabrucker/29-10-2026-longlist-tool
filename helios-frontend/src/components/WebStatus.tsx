"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import type { WebAccess } from "@/lib/chat";
import { useI18n } from "@/lib/i18n";
import { Globe } from "./icons";

/** The chat's web search switch, top right of its header: a blue globe while
 * web search is allowed, a grey one otherwise (Feather has no globe-x). A click turns it on or off
 * for the whole chat (a click is consent, like a card's allow button). */
export function WebStatus({
  web,
  onToggle,
}: {
  web: WebAccess;
  onToggle: (enabled: boolean) => Promise<void>;
}) {
  const { t } = useI18n();
  const [hovered, setHovered] = useState(false);
  const [saving, setSaving] = useState(false);
  const on = web !== "off";
  const label = on ? t("Turn web search off") : t("Turn web search on");

  async function toggle() {
    if (saving) return;
    setSaving(true);
    try {
      await onToggle(!on);
    } catch {
      /* the icon keeps showing the stored state */
    } finally {
      setSaving(false);
    }
  }

  return (
    <span className="relative flex shrink-0">
      <button
        type="button"
        aria-label={label}
        aria-pressed={on}
        onClick={toggle}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        className={`flex size-8 items-center justify-center rounded-full transition-colors hover:bg-subtle ${on ? "text-sky-ink" : "text-faint hover:text-muted"}`}
      >
        <Globe size={16} strokeWidth={1.75} />
      </button>
      <AnimatePresence>
        {hovered && (
          <motion.span
            key={label}
            role="tooltip"
            initial={{ opacity: 0, x: 2 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            transition={{ duration: 0.12, delay: 0.15 }}
            // To the left: the header clips anything below it.
            className="pointer-events-none absolute top-1/2 right-full mr-1 -translate-y-1/2 rounded-md bg-ink px-2 py-1 text-[12px] font-medium whitespace-nowrap text-white"
          >
            {label}
          </motion.span>
        )}
      </AnimatePresence>
    </span>
  );
}
