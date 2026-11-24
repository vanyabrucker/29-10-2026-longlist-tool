"use client";

import { AnimatePresence, motion } from "motion/react";
import { useState } from "react";
import { X } from "@/components/icons";
import { useChat } from "@/lib/chat";
import { useI18n, type MessageKey } from "@/lib/i18n";
import type { FeedbackRating } from "@/lib/sessions";

const EASE = [0.32, 0.72, 0, 1] as const;
const RATINGS: { value: FeedbackRating; label: MessageKey }[] = [
  { value: "bad", label: "Bad" },
  { value: "fine", label: "Fine" },
  { value: "good", label: "Good" },
];

/**
 * "How is Helios doing in this chat?" above the composer, once the chat has
 * a list: Bad / Fine / Good, then an optional comment. The rating is saved
 * on click; the comment is added to it. Closing the card before rating
 * dismisses the ask for this chat for good (saved on the gateway).
 */
export function ChatFeedback({
  conversationId,
  show,
}: {
  conversationId: string;
  show: boolean;
}) {
  const { t } = useI18n();
  const { feedbackFor, sendFeedback } = useChat();
  const state = feedbackFor(conversationId);
  // Rated in this visit: the comment step stays until sent or closed.
  const [rated, setRated] = useState<{ id: string; rating: FeedbackRating } | null>(null);
  const [comment, setComment] = useState("");
  const [closed, setClosed] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const commenting = rated?.id === conversationId;
  const visible =
    closed !== conversationId && ((show && state === null) || commenting);

  const send = async (body: { rating?: FeedbackRating | null; comment?: string }) => {
    setFailed(false);
    try {
      await sendFeedback(conversationId, body);
      return true;
    } catch {
      setFailed(true);
      return false;
    }
  };

  const rate = async (rating: FeedbackRating) => {
    if (await send({ rating })) setRated({ id: conversationId, rating });
  };

  const finish = async () => {
    if (comment.trim() && !(await send({ comment: comment.trim() }))) return;
    setComment("");
    setRated(null);
    setClosed(conversationId);
  };

  const close = async () => {
    if (commenting) return finish();
    if (await send({})) setClosed(conversationId);
  };

  return (
    <AnimatePresence initial={false}>
      {visible && (
        <motion.div
          key="feedback"
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 8, transition: { duration: 0.15 } }}
          transition={{ duration: 0.3, ease: EASE }}
          className="mb-2"
        >
          <div className="rounded-2xl border border-line bg-white px-3 py-2.5 shadow-[0_4px_20px_rgba(0,0,0,0.06)]">
            <div className="flex items-center gap-3">
              <p className="min-w-0 flex-1 truncate text-[14px] text-ink">
                {commenting
                  ? t("Thanks. Anything to add? (optional)")
                  : t("How is Helios doing in this chat?")}
              </p>
              {!commenting &&
                RATINGS.map((r) => (
                  <button
                    key={r.value}
                    type="button"
                    onClick={() => rate(r.value)}
                    className="h-8 rounded-full border border-line px-3.5 text-[13px] text-ink transition-colors hover:bg-subtle"
                  >
                    {t(r.label)}
                  </button>
                ))}
              <button
                type="button"
                aria-label={t("Close")}
                onClick={close}
                className="flex h-8 w-8 items-center justify-center rounded-full text-muted transition-colors hover:bg-subtle hover:text-ink"
              >
                <X size={16} />
              </button>
            </div>
            {commenting && (
              <form
                className="mt-2 flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  finish();
                }}
              >
                <input
                  autoFocus
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") finish();
                  }}
                  placeholder={t("What went well or wrong?")}
                  className="h-9 min-w-0 flex-1 rounded-lg border border-line px-3 text-[14px] text-ink outline-none placeholder:text-faint focus:border-sky focus:ring-2 focus:ring-sky"
                />
                <button
                  type="submit"
                  disabled={!comment.trim()}
                  className="h-9 rounded-full bg-ink px-4 text-[13px] text-white transition-opacity disabled:opacity-30"
                >
                  {t("Send")}
                </button>
              </form>
            )}
            {failed && (
              <p className="mt-1.5 text-[13px] text-bad">
                {t("Couldn't save. Try again.")}
              </p>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
