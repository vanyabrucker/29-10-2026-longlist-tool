import { requireDev } from "@/lib/gatewayServer";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "@/components/icons";
import { IssueList } from "@/components/IssueList";
import { critique, num, runs, samples } from "@/lib/data";
import { grade, pct } from "@/lib/format";
import { pairLabel } from "@/lib/models";

// Per-chat columns: (key, label, format).
const COLUMNS: [string, string, (v: number) => string][] = [
  ["scoring_passed", "Scoring passed", pct],
  ["scoring_judge_mean", "Judge mean", grade],
  ["transparency", "Transparency", grade],
  ["web_asked", "Asked for web", pct],
  ["weak_sources_flagged", "Weak sources flagged", pct],
  ["passed", "Filter passed", pct],
  ["unknown_kept", "Unknown kept", pct],
];

export default async function RunPage({ params }: { params: Promise<{ id: string }> }) {
  // Pages render alongside the layout, so each checks on its own.
  await requireDev();
  const { id } = await params;
  const run = (await runs()).find((r) => r.run_id === id);
  if (!run) notFound();
  const rows = await samples(id);
  const crit = await critique(id);
  const used = COLUMNS.filter(([k]) => rows.some((r) => num(r[k]) !== null));

  return (
    <>
      <div className="flex items-center gap-2">
        <Link href="/" aria-label="Back to runs"
          className="flex h-8 w-8 items-center justify-center rounded-full text-muted hover:bg-subtle hover:text-ink">
          <ArrowLeft size={18} />
        </Link>
        <h1 className="font-serif text-[28px]">Run {run.date.slice(0, 16)}</h1>
      </div>
      <p className="mt-1 text-[14px] text-muted">
        {pairLabel(run.agent_model, run.judge_model)} · {run.samples} scenarios ×{" "}
        {run.epochs} epochs · commit {run.git_commit || "–"}
        {run.git_dirty === "dirty" ? " (uncommitted changes)" : ""} · agent setup{" "}
        <span className="font-mono text-[12px]">{run.agent_config}</span>
      </p>
      {run.note && <p className="mt-2 text-[14px]">{run.note}</p>}

      <h2 className="mt-8 mb-3 text-[16px] font-medium">Chats</h2>
      <div className="overflow-hidden rounded-xl border border-line">
        <table className="w-full text-[13px]">
          <thead className="bg-canvas text-left text-muted">
            <tr>
              <th className="px-3 py-2 font-normal">Scenario</th>
              <th className="px-3 py-2 font-normal">Epoch</th>
              {used.map(([, label]) => (
                <th key={label} className="px-3 py-2 font-normal">{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.sample}-${r.epoch}`} className="border-t border-hairline align-top">
                <td className="px-3 py-2">
                  <div>{r.sample}</div>
                  {r.reason && (
                    <details className="mt-1 max-w-[520px] text-muted">
                      <summary className="cursor-pointer text-[12px] hover:text-ink">
                        Judge&apos;s reasons
                      </summary>
                      <p className="mt-1 whitespace-pre-wrap text-[12px]">{r.reason}</p>
                    </details>
                  )}
                  {r.error && <div className="text-[12px] text-bad">Errored</div>}
                </td>
                <td className="px-3 py-2">{r.epoch}</td>
                {used.map(([key, , f]) => {
                  const v = num(r[key]);
                  return <td key={key} className="px-3 py-2">{v === null ? "–" : f(v)}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2 className="mt-8 mb-3 text-[16px] font-medium">Why it lost points</h2>
      {crit ? (
        <IssueList critique={crit} />
      ) : (
        <p className="rounded-xl border border-line p-6 text-center text-[14px] text-muted">
          Not critiqued.{" "}
          {run.task === "helios_scenarios"
            ? "Runs recorded before the critique step aren't critiqued on their own; run "
            : "Replays hold private chats and aren't critiqued."}
          {run.task === "helios_scenarios" && (
            <code className="font-mono text-[13px]">uv run python -m evals.critique LOG</code>
          )}
        </p>
      )}
    </>
  );
}
