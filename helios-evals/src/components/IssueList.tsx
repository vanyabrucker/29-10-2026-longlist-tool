import type { Critique } from "@/lib/data";

const GAIN_LABEL = { low: "Low gain", medium: "Medium gain", high: "High gain" };

/** A run's critique: issues ranked by priority (points lost × expected gain),
 * each with its proposal and, folded, the shortfalls it explains. */
export function IssueList({ critique }: { critique: Critique }) {
  const byId = new Map(critique.shortfalls.map((s) => [s.id, s]));
  if (critique.issues.length === 0)
    return (
      <p className="rounded-xl border border-line p-6 text-center text-[14px] text-muted">
        {critique.shortfalls.length === 0
          ? "Nothing lost a point in this run."
          : "The critic grouped no issues."}
      </p>
    );
  return (
    <ol className="flex flex-col gap-3">
      {critique.issues.map((issue, n) => (
        <li key={n} className="rounded-xl border border-line p-4">
          <div className="flex items-start gap-3">
            <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-subtle text-[12px] text-muted">
              {n + 1}
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="text-[15px] font-medium">{issue.title}</h3>
                <span
                  className={`rounded-full px-2 py-0.5 text-[12px] ${
                    issue.fix_in === "eval" ? "bg-subtle text-muted" : "bg-sky text-sky-ink"
                  }`}
                >
                  Fix in the {issue.fix_in}
                </span>
                <span className="text-[12px] text-faint">{issue.where}</span>
              </div>
              <p className="mt-1.5 text-[14px] text-muted">{issue.diagnosis}</p>
              <p className="mt-2 text-[14px]">
                <span className="text-muted">Proposal: </span>
                {issue.proposal}
              </p>
              <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted">
                <span>Priority {issue.priority.toFixed(2)}</span>
                <span>{issue.chats} {issue.chats === 1 ? "chat" : "chats"}</span>
                <span>{issue.points_lost.toFixed(2)} points lost</span>
                <span>{GAIN_LABEL[issue.gain]}</span>
                {issue.criteria.length > 0 && <span>{issue.criteria.join(", ")}</span>}
              </div>
              <details className="mt-2 text-[13px]">
                <summary className="cursor-pointer text-muted hover:text-ink">
                  Evidence ({issue.shortfalls.length})
                </summary>
                <ul className="mt-2 flex flex-col gap-1.5">
                  {issue.shortfalls.map((id) => {
                    const s = byId.get(id);
                    if (!s) return null;
                    return (
                      <li key={id} className="rounded-lg bg-canvas px-3 py-2">
                        <span className="text-faint">
                          {s.sample} #{s.epoch} · {s.kind} {s.name}
                          {s.value !== null ? ` = ${s.value}` : ""}
                        </span>
                        <div className="mt-0.5 whitespace-pre-wrap">{s.reason}</div>
                      </li>
                    );
                  })}
                </ul>
              </details>
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}
