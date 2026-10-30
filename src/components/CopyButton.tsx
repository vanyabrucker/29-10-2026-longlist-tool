"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Check, Copy } from "react-feather";

export function CopyButton({ text }: { text: string }) {
  const [hovered, setHovered] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(t);
  }, [copied]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
    } catch {}
    setCopied(true);
  }

  const showTooltip = hovered && !copied;

  return (
    <div className="relative inline-flex">
      <motion.button
        type="button"
        aria-label={copied ? "Copied" : "Copy"}
        onClick={copy}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        whileTap={{ scale: 0.85 }}
        className="flex size-8 items-center justify-center rounded-lg text-[#5d5d63] transition-colors hover:bg-subtle hover:text-ink"
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
              <Check size={15} strokeWidth={2} />
            ) : (
              <Copy size={15} strokeWidth={1.75} />
            )}
          </motion.span>
        </AnimatePresence>
      </motion.button>

      <AnimatePresence>
        {showTooltip && (
          <motion.span
            role="tooltip"
            initial={{ opacity: 0, y: -2 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.08 } }}
            transition={{ duration: 0.12, delay: 0.15 }}
            className="pointer-events-none absolute top-full left-1/2 mt-1 -translate-x-1/2 rounded-md bg-ink px-2 py-1 text-[12px] font-medium whitespace-nowrap text-white"
          >
            Copy
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}
