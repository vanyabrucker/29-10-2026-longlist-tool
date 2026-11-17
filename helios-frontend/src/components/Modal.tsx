"use client";

import { AnimatePresence, motion } from "motion/react";
import { useEffect } from "react";

const EASE = [0.32, 0.72, 0, 1] as const;

/**
 * A centred dialog over a dim backdrop, styled like the version restore
 * dialog. `onClose` runs on Escape and backdrop clicks; leave it out for a
 * dialog that must be closed with its own button (e.g. a one-time password).
 */
export function Modal({
  open,
  onClose,
  labelledBy,
  children,
}: {
  open: boolean;
  onClose?: () => void;
  labelledBy: string;
  children: React.ReactNode;
}) {
  useEffect(() => {
    if (!open || !onClose) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          onClick={onClose}
          className="fixed inset-0 z-[80] flex items-center justify-center bg-black/25 px-4"
        >
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={labelledBy}
            initial={{ opacity: 0, scale: 0.96, y: 6 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: 6 }}
            transition={{ duration: 0.2, ease: EASE }}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-w-[400px] rounded-xl border border-line bg-white p-5 text-left shadow-[0_12px_40px_rgba(0,0,0,0.12)]"
          >
            {children}
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export const modalButton =
  "h-[32px] rounded-full px-3.5 text-[14px] font-medium transition-colors";
export const modalPrimary = `${modalButton} bg-ink text-white hover:bg-[#26262a] disabled:opacity-60`;
export const modalSecondary = `${modalButton} border border-line hover:bg-subtle`;
