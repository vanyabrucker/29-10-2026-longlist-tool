"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Check, Copy } from "@/components/icons";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { HoverTooltip } from "./HoverTooltip";

/** A LinkedIn URL without its scheme, "www." and trailing slash. */
export const shortLinkedIn = (url: string) =>
  url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "");

/** A contact detail (email, phone, LinkedIn) as a link that hugs its text.
 * On hover it gets an input-like box and a copy button slides in on its
 * right; the button copies `value`, which may differ from the shown text. */
export function CopyableLink({
  href,
  text,
  value,
  copyLabel,
  external,
  numeric,
  small,
}: {
  href: string;
  text: string;
  value: string;
  copyLabel: MessageKey;
  external?: boolean;
  numeric?: boolean;
  /** 24px high, for the stacked popover form. */
  small?: boolean;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  // The check shows only when the value really was copied; a browser that
  // refuses clipboard access leaves the copy icon as it was.
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    setCopied(true);
  }

  return (
    <div
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
      className={`group/copy relative -ml-2 flex ${small ? "h-6" : "h-8"} w-fit max-w-[calc(100%+8px)] min-w-0 items-center rounded-lg border border-transparent transition-colors hover:border-line`}
    >
      <a
        href={href}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className={`block min-w-0 truncate pr-2 pl-2 transition-[padding] duration-150 group-hover/copy:pr-8 hover:underline ${numeric ? "tabular-nums" : ""}`}
      >
        {text}
      </a>
      <motion.button
        type="button"
        aria-label={t(copyLabel)}
        onClick={copy}
        whileTap={{ scale: 0.85 }}
        className={`absolute right-1 flex ${small ? "size-5" : "size-6"} items-center justify-center rounded-md text-muted opacity-0 transition-[opacity,color,background-color] group-hover/copy:opacity-100 hover:bg-subtle hover:text-ink focus-visible:opacity-100`}
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={copied ? "check" : "copy"}
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: copied ? [0.6, 1.25, 1] : 1, opacity: 1 }}
            exit={{ scale: 0.6, opacity: 0 }}
            transition={{ duration: copied ? 0.3 : 0.15, ease: "easeOut" }}
            className="flex"
          >
            {copied ? (
              <Check size={13} strokeWidth={2} />
            ) : (
              <Copy size={13} strokeWidth={1.75} />
            )}
          </motion.span>
        </AnimatePresence>
        <HoverTooltip label={copied ? t("Copied") : t(copyLabel)} />
      </motion.button>
    </div>
  );
}
