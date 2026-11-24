"use client";

import { useCallback, useEffect, useState } from "react";
import { Check } from "@/components/icons";

type Feedback = {
  id: string;
  session_id: string | null;
  owner: string;
  owner_name: string;
  session_title: string;
  agent_config_version: number | null;
  rating: "bad" | "fine" | "good";
  comment: string | null;
  status: "todo" | "in_progress" | "done";
  note: string | null;
  analyzed_by: string | null;
  dataset_sample: string | null;
  created_at: string;
};

const STATUSES = [
  { value: "todo", label: "Todo" },
  { value: "in_progress", label: "In progress" },
  { value: "done", label: "Done" },
] as const;

const RATING = {
  bad: { label: "Bad", dot: "bg-bad" },
  fine: { label: "Fine", dot: "bg-warn" },
  good: { label: "Good", dot: "bg-good" },
};

const when = (iso: string) =>
  new Date(iso).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function FeedbackBoard() {
  const [items, setItems] = useState<Feedback[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Feedback["status"] | "all">("todo");
  const [rating, setRating] = useState<Feedback["rating"] | "all">("all");

  const load = useCallback(async () => {
    const r = await fetch("/api/gateway/feedback", { cache: "no-store" });
    if (!r.ok) {
      setError((await r.json().catch(() => ({}))).detail ?? "Couldn't load the feedback.");
      return;
    }
    setItems((await r.json()).items);
  }, []);

  useEffect(() => {
    load(); // eslint-disable-line react-hooks/set-state-in-effect -- fetch on mount
  }, [load]);

  const patch = async (id: string, body: Partial<Feedback>) => {
    const r = await fetch(`/api/gateway/feedback/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      setError((await r.json().catch(() => ({}))).detail ?? "Couldn't save.");
      return;
    }
    const row = (await r.json()) as Feedback;
    setItems((prev) => prev?.map((x) => (x.id === id ? { ...x, ...row } : x)) ?? null);
  };

  if (error && !items) return <p className="mt-6 text-[14px] text-bad">{error}</p>;
  if (!items) return <p className="mt-6 text-[14px] text-faint">Loading…</p>;

  const count = (s: Feedback["status"]) => items.filter((x) => x.status === s).length;
  const shown = items.filter(
    (x) => (tab === "all" || x.status === tab) && (rating === "all" || x.rating === rating),
  );

  return (
    <>
      <div className="mt-5 flex flex-wrap items-center gap-2">
        {[...STATUSES, { value: "all" as const, label: "All" }].map((s) => (
          <button
            key={s.value}
            type="button"
            onClick={() => setTab(s.value)}
            className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] ${
              tab === s.value ? "border-sky bg-sky text-sky-ink" : "border-line text-muted hover:text-ink"
            }`}
          >
            {s.label}
            <span className="text-[12px] opacity-70">
              {s.value === "all" ? items.length : count(s.value)}
            </span>
          </button>
        ))}
        <span className="mx-2 h-5 w-px bg-line" />
        {(["all", "bad", "fine", "good"] as const).map((r) => (
          <button
            key={r}
            type="button"
            onClick={() => setRating(r)}
            className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-[13px] ${
              rating === r ? "border-sky bg-sky text-sky-ink" : "border-line text-muted hover:text-ink"
            }`}
          >
            {r !== "all" && <span className={`h-2 w-2 rounded-full ${RATING[r].dot}`} />}
            {r === "all" ? "Any rating" : RATING[r].label}
          </button>
        ))}
      </div>
      {error && <p className="mt-3 text-[13px] text-bad">{error}</p>}

      {shown.length === 0 ? (
        <p className="mt-5 rounded-xl border border-line p-6 text-center text-[14px] text-muted">
          No feedback here.
        </p>
      ) : (
        <ul className="mt-5 flex flex-col gap-3">
          {shown.map((f) => (
            <FeedbackRow key={f.id} f={f} onPatch={(body) => patch(f.id, body)}
              onAdded={(sample) => setItems((prev) =>
                prev?.map((x) => (x.id === f.id ? { ...x, dataset_sample: sample } : x)) ?? null)} />
          ))}
        </ul>
      )}
    </>
  );
}

function FeedbackRow({
  f,
  onPatch,
  onAdded,
}: {
  f: Feedback;
  onPatch: (body: Partial<Feedback>) => Promise<void>;
  onAdded: (sample: string) => void;
}) {
  const [note, setNote] = useState(f.note ?? "");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const addToDataset = async () => {
    setAdding(true);
    setAddError(null);
    const r = await fetch("/api/dataset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: f.session_id, feedback_id: f.id }),
    });
    setAdding(false);
    const data = await r.json().catch(() => ({}));
    if (r.ok) onAdded(data.sample);
    else setAddError(data.detail ?? "Couldn't add the chat.");
  };

  return (
    <li className="rounded-xl border border-line p-4">
      <div className="flex items-start gap-3">
        <span className="mt-0.5 flex items-center gap-1.5 rounded-full bg-subtle px-2 py-0.5 text-[12px]">
          <span className={`h-2 w-2 rounded-full ${RATING[f.rating].dot}`} />
          {RATING[f.rating].label}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium">{f.session_title || "Untitled chat"}</div>
          <div className="mt-0.5 text-[12px] text-faint">
            {f.owner_name} · {when(f.created_at)}
            {f.agent_config_version !== null && ` · agent setup v${f.agent_config_version}`}
            {f.session_id ? "" : " · chat deleted"}
          </div>
          {f.comment ? (
            <p className="mt-2 whitespace-pre-wrap text-[14px]">“{f.comment}”</p>
          ) : (
            <p className="mt-2 text-[13px] text-faint">No comment.</p>
          )}
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => note !== (f.note ?? "") && onPatch({ note })}
            placeholder="Your analysis (saved when you leave the field)"
            rows={2}
            className="mt-3 w-full resize-y rounded-lg border border-line px-3 py-2 text-[13px] outline-none placeholder:text-faint focus:border-sky focus:ring-2 focus:ring-sky"
          />
          {f.analyzed_by && <div className="mt-1 text-[12px] text-faint">Last changed by {f.analyzed_by}</div>}
        </div>
        <div className="flex w-[190px] shrink-0 flex-col items-stretch gap-2">
          <select
            value={f.status}
            onChange={(e) => onPatch({ status: e.target.value as Feedback["status"] })}
            aria-label="Status"
            className="h-9 rounded-lg border border-line bg-white px-2.5 text-[13px] outline-none focus:border-sky focus:ring-2 focus:ring-sky"
          >
            {STATUSES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
          {f.dataset_sample ? (
            <span className="flex h-9 items-center justify-center gap-1.5 text-[13px] text-muted">
              <Check size={14} /> In the eval dataset
            </span>
          ) : (
            <button
              type="button"
              disabled={!f.session_id || adding}
              onClick={addToDataset}
              title={f.session_id ? "Export this chat as a replay sample" : "The chat was deleted"}
              className="h-9 rounded-full border border-line text-[13px] hover:bg-subtle disabled:opacity-40"
            >
              {adding ? "Adding…" : "Add to eval dataset"}
            </button>
          )}
          {addError && <p className="text-[12px] text-bad">{addError}</p>}
        </div>
      </div>
    </li>
  );
}
