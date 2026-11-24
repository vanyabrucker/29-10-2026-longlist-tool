"use client";

import { useCallback, useRef, useState } from "react";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { useDismiss } from "@/lib/useDismiss";
import type { Transform } from "@/lib/gateway";
import { Check, Plus } from "./icons";

export const SCALE_LABEL: Record<1000 | 1000000, MessageKey> = {
  1000: "× 1,000",
  1000000: "× 1,000,000",
};

type Kind = Transform["kind"];

const KINDS: { kind: Kind; label: MessageKey }[] = [
  { kind: "empty_values", label: "Treat as empty" },
  { kind: "combine", label: "Combine with columns" },
  { kind: "scale", label: "Scale" },
];

const INPUT =
  "h-9 w-full rounded-lg border border-line bg-white px-2.5 text-[13.5px] text-ink outline-none placeholder:text-faint focus:border-[#c9d9ef] focus:ring-3 focus:ring-sky";

/** The popover behind a column's "+" or a transformation chip: pick a kind,
 * fill it in, apply. `others` are the table's other columns for "Combine". */
export function TransformEditor({
  letter,
  others,
  initial,
  onSave,
  onRemove,
  busy,
}: {
  letter: string;
  others: { letter: string; header: string }[];
  /** Set when a chip was clicked: that transformation is edited. */
  initial?: Transform;
  onSave: (t: Transform) => void;
  onRemove?: () => void;
  busy: boolean;
}) {
  const { t } = useI18n();

  const [kind, setKind] = useState<Kind | null>(initial?.kind ?? null);
  const [values, setValues] = useState(
    initial?.kind === "empty_values" ? initial.values.join(", ") : "",
  );
  const [columns, setColumns] = useState<string[]>(
    initial?.kind === "combine" ? initial.columns : [],
  );
  const [separator, setSeparator] = useState(
    initial?.kind === "combine" ? initial.separator : ", ",
  );
  const [factor, setFactor] = useState<1000 | 1000000>(
    initial?.kind === "scale" ? initial.factor : 1000,
  );

  const parsed = values
    .split(",")
    .map((v) => v.trim())
    .filter(Boolean);
  const valid =
    kind === "empty_values"
      ? parsed.length > 0
      : kind === "combine"
        ? columns.length > 0
        : kind === "scale";

  function apply() {
    if (kind === "empty_values") onSave({ kind, values: parsed });
    else if (kind === "combine") onSave({ kind, columns, separator });
    else if (kind === "scale") onSave({ kind, factor });
  }

  return (
    <div
      role="dialog"
      aria-label={t("Transformations of column {letter}", { letter })}
      className="absolute top-full left-0 z-20 mt-1 w-[300px] rounded-xl border border-line bg-white p-1 shadow-[0_4px_20px_rgba(0,0,0,0.08)]"
    >
      {kind === null ? (
        KINDS.map((k) => (
          <button
            key={k.kind}
            type="button"
            onClick={() => setKind(k.kind)}
            className="flex h-9 w-full items-center rounded-lg px-3 text-left text-[13.5px] hover:bg-subtle"
          >
            {t(k.label)}
          </button>
        ))
      ) : (
        <div className="flex flex-col gap-2.5 p-2">
          <span className="text-[13px] font-medium">
            {t(KINDS.find((k) => k.kind === kind)!.label)}
          </span>
          {kind === "empty_values" && (
            <input
              autoFocus
              value={values}
              onChange={(e) => setValues(e.target.value)}
              aria-label={t("Values to treat as empty, separated by commas")}
              placeholder={t("e.g. n/a, unknown, -")}
              className={INPUT}
            />
          )}
          {kind === "combine" && (
            <>
              <ul className="max-h-[180px] overflow-y-auto">
                {others.map((o) => (
                  <li key={o.letter}>
                    <label className="flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-1.5 text-[13.5px] hover:bg-subtle">
                      <input
                        type="checkbox"
                        checked={columns.includes(o.letter)}
                        onChange={(e) =>
                          // The order is the user's: click order.
                          setColumns((cur) =>
                            e.target.checked
                              ? [...cur, o.letter]
                              : cur.filter((l) => l !== o.letter),
                          )
                        }
                        className="size-4 shrink-0 accent-ink"
                      />
                      <span className="w-4 shrink-0 text-[12px] font-medium text-sky-ink tabular-nums">
                        {columns.includes(o.letter)
                          ? columns.indexOf(o.letter) + 1
                          : ""}
                      </span>
                      <span className="w-5 shrink-0 text-[12px] text-faint tabular-nums">
                        {o.letter}
                      </span>
                      <span className="min-w-0 truncate">{o.header}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <label className="flex flex-col gap-1 text-[12.5px] text-muted">
                {t("Separator")}
                <input
                  value={separator}
                  maxLength={5}
                  onChange={(e) => setSeparator(e.target.value)}
                  className={INPUT}
                />
              </label>
            </>
          )}
          {kind === "scale" && (
            <div className="flex flex-col" role="radiogroup">
              {([1000, 1000000] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  role="radio"
                  aria-checked={factor === f}
                  onClick={() => setFactor(f)}
                  className="flex h-9 items-center justify-between rounded-lg px-3 text-[13.5px] hover:bg-subtle"
                >
                  {t(SCALE_LABEL[f])}
                  {factor === f && <Check size={14} strokeWidth={1.75} />}
                </button>
              ))}
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            {onRemove ? (
              <button
                type="button"
                disabled={busy}
                onClick={onRemove}
                className="h-8 rounded-full border border-line px-3.5 text-[13px] hover:bg-subtle disabled:opacity-50"
              >
                {t("Remove")}
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              disabled={!valid || busy}
              onClick={apply}
              className="h-8 rounded-full bg-ink px-4 text-[13px] font-medium text-white disabled:opacity-50"
            >
              {t("Apply")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** A mapped column's transformations: one chip each (click to edit) and a
 * small "+" that adds one. Changes go up whole; the parent saves them. */
export function TransformControls({
  letter,
  transforms,
  others,
  onChange,
  busy,
}: {
  letter: string;
  transforms: Transform[];
  others: { letter: string; header: string }[];
  onChange: (next: Transform[]) => void;
  busy: boolean;
}) {
  const { t } = useI18n();
  // null: closed; -1: adding; otherwise the chip being edited.
  const [open, setOpen] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(null), []);
  useDismiss(ref, open !== null, close);

  const headerOf = (l: string) =>
    others.find((o) => o.letter === l)?.header ?? l;
  const label = (tr: Transform) =>
    tr.kind === "empty_values"
      ? t("Empty: {values}", { values: tr.values.join(", ") })
      : tr.kind === "combine"
        ? t("Combined with {columns}", {
            columns: tr.columns.map((l) => `${l} ${headerOf(l)}`).join(", "),
          })
        : t(SCALE_LABEL[tr.factor]);

  return (
    <div ref={ref} className="relative flex flex-wrap items-center gap-1.5">
      {transforms.map((tr, i) => (
        <button
          key={i}
          type="button"
          title={t("Edit transformation")}
          disabled={busy}
          onClick={() => setOpen(open === i ? null : i)}
          className="max-w-[200px] truncate rounded-full bg-subtle px-2.5 py-[3px] text-[12.5px] text-muted hover:text-ink disabled:opacity-50"
        >
          {label(tr)}
        </button>
      ))}
      <button
        type="button"
        disabled={busy}
        onClick={() => setOpen(open === -1 ? null : -1)}
        aria-label={t("Add transformation")}
        aria-expanded={open === -1}
        title={t("Add transformation")}
        className="flex size-6 items-center justify-center rounded-full border border-line text-muted hover:bg-subtle hover:text-ink disabled:opacity-50"
      >
        <Plus size={12} strokeWidth={1.75} />
      </button>
      {open !== null && (
        <TransformEditor
          key={open}
          busy={busy}
          letter={letter}
          others={others}
          initial={open >= 0 ? transforms[open] : undefined}
          onSave={(tr) => {
            onChange(
              open >= 0
                ? transforms.map((x, i) => (i === open ? tr : x))
                : [...transforms, tr],
            );
            close();
          }}
          onRemove={
            open >= 0
              ? () => {
                  onChange(transforms.filter((_, i) => i !== open));
                  close();
                }
              : undefined
          }
        />
      )}
    </div>
  );
}
