"use client";

import { AnimatePresence, motion } from "motion/react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  ArrowUp,
  Command,
  CornerDownLeft,
  File,
  Plus,
  Table,
  X,
} from "react-feather";
import type { Attachment } from "@/lib/chat";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { useDismiss } from "@/lib/useDismiss";

const PROMPTS: MessageKey[] = [
  "Find new market entrants in Swiss solar installation",
  "Build a buyer longlist for a DACH packaging business",
  "Who are the decision makers at mid-market PE funds in Milan?",
  "Track founder-led medtech companies preparing to raise",
];

const MAX_INPUT_HEIGHT = 200;

// Types out example prompts into the placeholder, like the reference design.
function useTypewriter(enabled: boolean) {
  const { t } = useI18n();
  const [text, setText] = useState("");

  useEffect(() => {
    if (!enabled) return;
    let prompt = 0;
    let len = 0;
    let deleting = false;
    let timer: ReturnType<typeof setTimeout>;

    const step = () => {
      const full = t(PROMPTS[prompt]);
      len += deleting ? -1 : 1;
      setText(full.slice(0, len));
      let delay = deleting ? 18 : 55;
      if (!deleting && len === full.length) {
        deleting = true;
        delay = 2200;
      } else if (deleting && len === 0) {
        deleting = false;
        prompt = (prompt + 1) % PROMPTS.length;
        delay = 400;
      }
      timer = setTimeout(step, delay);
    };
    timer = setTimeout(step, 600);
    return () => clearTimeout(timer);
  }, [enabled, t]);

  return text;
}

export function Composer({
  onSubmit,
  variant,
  generating = false,
  onStop,
  files = [],
  onAddFiles,
  onRemoveFile,
}: {
  onSubmit: (text: string) => void;
  /** Attached files, shown as cards above the text (dropped or uploaded). */
  files?: Attachment[];
  onAddFiles?: (files: Attachment[]) => void;
  onRemoveFile?: (index: number) => void;
  /** While a reply runs, the send button turns into a stop button. */
  generating?: boolean;
  onStop?: () => void;
  /** "panel" is the boxed layout used in the narrow chat column next to the table. */
  variant: "home" | "chat" | "panel";
}) {
  const { t } = useI18n();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const typed = useTypewriter(variant === "home");
  const canSend = value.trim().length > 0 || files.length > 0;
  // The pill composer keeps plus, text and send on one line until the text
  // wraps; then the text gets the full width and the buttons drop to a row
  // below (like ChatGPT). It stays that way until the input is cleared, so
  // it doesn't flip back and forth at the wrap point.
  const [expanded, setExpanded] = useState(false);
  if (expanded && value === "") setExpanded(false);
  // Attachments always get the roomy layout, cards above the text.
  const roomy = expanded || files.length > 0;
  const fileCards = files.length > 0 && (
    <div className="flex flex-wrap gap-2">
      {files.map((f, i) => (
        <FileCard
          key={`${f.name}-${i}`}
          file={f}
          onRemove={onRemoveFile ? () => onRemoveFile(i) : undefined}
        />
      ))}
    </div>
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, [variant]);

  // Grow with the content up to a cap, then scroll.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = "auto";
    // One line is 22px plus 11px padding above and below.
    if (variant !== "panel" && !expanded && el.scrollHeight > 46)
      setExpanded(true);
    el.style.height = `${Math.min(el.scrollHeight, MAX_INPUT_HEIGHT)}px`;
  }, [value, variant, expanded]);

  function submit(e?: React.FormEvent) {
    e?.preventDefault();
    if (!canSend || generating) return;
    onSubmit(value.trim());
    setValue("");
  }

  // Cmd/Ctrl+Enter sends; a plain Enter inserts a newline.
  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey) &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      submit();
    }
  }

  const textarea = (
    <textarea
      ref={inputRef}
      rows={1}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={onKeyDown}
      placeholder={variant === "home" ? typed : t("Ask Helios")}
      aria-label={t("Message Helios")}
      className={`min-w-0 flex-1 resize-none bg-transparent text-[15px] leading-[22px] outline-none placeholder:text-muted ${
        variant === "panel"
          ? "min-h-[44px] px-1 pt-1"
          : roomy
            ? `col-span-3 px-[10px] py-[11px] ${files.length ? "row-start-2" : "row-start-1"}`
            : "col-start-2 row-start-1 px-3 py-[11px]"
      }`}
    />
  );

  if (variant === "panel") {
    return (
      <form
        onSubmit={submit}
        className="flex flex-col rounded-2xl border border-[#E5E7EB] bg-white px-3 pt-3 pb-2.5 shadow-[0_2px_10px_rgba(0,0,0,0.03)]"
      >
        {fileCards && <div className="mb-2">{fileCards}</div>}
        {textarea}
        <div className="mt-2 flex items-center justify-between">
          <UploadMenu placement="panel" onAddFiles={onAddFiles} />
          {generating ? (
            <StopButton onStop={onStop} size={36} />
          ) : (
            <SendButton disabled={!canSend} size={36} />
          )}
        </div>
      </form>
    );
  }

  const buttonRow = !roomy
    ? "row-start-1"
    : files.length
      ? "row-start-3"
      : "row-start-2";

  // One grid in both layouts, so the textarea never remounts (and keeps
  // focus and caret) when the buttons move. Expanded, the text starts where
  // the plus glyph's stroke does (28px in; Feather's plus is inset in its box).
  return (
    <form
      onSubmit={submit}
      className={`grid grid-cols-[auto_1fr_auto] items-center border border-[#E5E7EB] bg-white py-[13px] pr-[13px] pl-[18px] shadow-[0_2px_10px_rgba(0,0,0,0.03)] ${
        roomy ? "gap-y-1 rounded-2xl" : "min-h-[72px] rounded-2xl"
      }`}
    >
      {fileCards && (
        <div className="col-span-3 row-start-1 px-[4px] pt-[4px]">
          {fileCards}
        </div>
      )}
      {textarea}
      <div className={`col-start-1 ${buttonRow}`}>
        <UploadMenu
          placement={variant === "chat" ? "above" : "below"}
          onAddFiles={onAddFiles}
        />
      </div>
      <div className={`col-start-3 ${buttonRow}`}>
        {generating ? (
          <StopButton onStop={onStop} size={44} />
        ) : (
          <SendButton disabled={!canSend} size={44} />
        )}
      </div>
    </form>
  );
}

const TOOLTIP =
  "pointer-events-none absolute right-0 bottom-full mb-2 flex items-center gap-1.5 rounded-md bg-ink py-1 text-[12px] font-medium whitespace-nowrap text-white opacity-0 transition-opacity duration-150 group-hover:opacity-100 group-hover:delay-150";

// Same black circle as send, with a filled square.
function StopButton({ onStop, size }: { onStop?: () => void; size: number }) {
  const { t } = useI18n();
  return (
    <div className="group relative">
      <button
        type="button"
        aria-label={t("Stop generating")}
        onClick={onStop}
        style={{ width: size, height: size }}
        className="flex shrink-0 items-center justify-center rounded-full bg-ink text-white transition-colors duration-200 hover:bg-[#26262a]"
      >
        <span className="size-[11px] rounded-[2px] bg-white" />
      </button>
      <span role="tooltip" className={`${TOOLTIP} px-2`}>
        {t("Stop")}
      </span>
    </div>
  );
}

function SendButton({ disabled, size }: { disabled: boolean; size: number }) {
  const { t } = useI18n();
  return (
    <div className="group relative">
      <button
        type="submit"
        aria-label={t("Send (Cmd+Enter)")}
        disabled={disabled}
        style={{ width: size, height: size }}
        className="flex shrink-0 items-center justify-center rounded-full bg-ink text-white transition-colors duration-200 disabled:bg-[#c4c4c8]"
      >
        <ArrowUp size={16} strokeWidth={2} />
      </button>
      <span role="tooltip" className={`${TOOLTIP} pr-1 pl-2`}>
        {t("Enter")}
        <span className="flex gap-0.5">
          <Kbd>
            <Command size={10} strokeWidth={2} />
          </Kbd>
          <Kbd>
            <CornerDownLeft size={10} strokeWidth={2} />
          </Kbd>
        </span>
      </span>
    </div>
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="flex size-[18px] items-center justify-center rounded bg-white/15">
      {children}
    </kbd>
  );
}

// "below"/"above": plus at the pill composer's left, menu opening down or up.
// "panel": grey round plus at the bottom-left of the boxed composer.
function UploadMenu({
  placement,
  onAddFiles,
}: {
  placement: "below" | "above" | "panel";
  onAddFiles?: (files: Attachment[]) => void;
}) {
  const { t } = useI18n();
  const inputRef = useRef<HTMLInputElement>(null);
  const openUpward = placement !== "below";
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  return (
    <div
      ref={ref}
      className={`relative flex items-center ${placement === "panel" ? "" : "h-[44px]"}`}
    >
      <input
        ref={inputRef}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          const picked = [...(e.target.files ?? [])];
          if (picked.length)
            onAddFiles?.(picked.map(({ name, size }) => ({ name, size })));
          e.target.value = "";
        }}
      />
      <button
        type="button"
        aria-label={t("Add attachment")}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={
          placement === "panel"
            ? "flex size-9 items-center justify-center rounded-full bg-subtle text-[#3a3a3f] transition-colors hover:bg-[#e8e8ea]"
            : `rounded-full p-1.5 text-[#3a3a3f] transition-colors hover:bg-subtle ${open ? "bg-subtle" : ""}`
        }
      >
        <Plus size={placement === "panel" ? 18 : 20} strokeWidth={1.5} />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.96, y: openUpward ? 4 : -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className={`absolute z-20 w-48 rounded-xl border border-line bg-white p-1 shadow-[0_4px_20px_rgba(0,0,0,0.08)] ${
              placement === "panel"
                ? "bottom-full left-0 mb-2 origin-bottom-left"
                : openUpward
                  ? "bottom-full left-0 mb-2 origin-bottom-left"
                  : "top-full left-0 mt-2 origin-top-left"
            }`}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                setOpen(false);
                inputRef.current?.click();
              }}
              className="flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] transition-colors hover:bg-subtle"
            >
              <File size={15} strokeWidth={1.75} className="text-[#5d5d63]" />
              {t("Upload a file")}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * An attached file: a green sheet icon for spreadsheets, a grey file icon
 * otherwise, the name and kind. With onRemove, hovering shows a small ×.
 */
export function FileCard({
  file,
  onRemove,
}: {
  file: Attachment;
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  const sheet = /\.(xlsx|xls|csv)$/i.test(file.name);
  return (
    <div className="group/file relative flex w-[240px] items-center gap-2.5 rounded-xl border border-line bg-white p-2 pr-3">
      <span
        className={`flex size-9 shrink-0 items-center justify-center rounded-lg ${sheet ? "border border-line bg-white text-sheet" : "bg-subtle text-[#5d5d63]"}`}
      >
        {sheet ? (
          <Table size={16} strokeWidth={1.75} />
        ) : (
          <File size={16} strokeWidth={1.75} />
        )}
      </span>
      <span className="min-w-0 text-left">
        <span className="block truncate text-[13.5px] leading-tight font-medium">
          {file.name}
        </span>
        <span className="block text-[12px] leading-tight text-muted">
          {t(sheet ? "Spreadsheet" : "File")}
        </span>
      </span>
      {onRemove && (
        <button
          type="button"
          aria-label={t("Remove file")}
          onClick={onRemove}
          className="absolute -top-1.5 -right-1.5 flex size-5 items-center justify-center rounded-full bg-ink text-white opacity-0 transition-opacity group-hover/file:opacity-100 focus-visible:opacity-100"
        >
          <X size={11} strokeWidth={2.5} />
        </button>
      )}
    </div>
  );
}
