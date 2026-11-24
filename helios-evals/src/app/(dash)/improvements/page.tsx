import { requireDev } from "@/lib/gatewayServer";
import Link from "next/link";
import { IssueList } from "@/components/IssueList";
import { critiques, runs } from "@/lib/data";
import { modelLabel } from "@/lib/models";

export default async function ImprovementsPage({
  searchParams,
}: {
  searchParams: Promise<{ run?: string }>;
}) {
  // Pages render alongside the layout, so each checks on its own.
  await requireDev();
  const all = await critiques();
  const notes = new Map((await runs()).map((r) => [r.run_id, r]));
  const wanted = (await searchParams).run;
  const current = all.find((c) => c.run_id === wanted) ?? all[0];

  return (
    <>
      <h1 className="font-serif text-[28px]">Improvements</h1>
      <p className="mt-1 max-w-[760px] text-[14px] text-muted">
        After every scenario run, a critic groups the points lost (judge criteria below 5, failed
        checks) into issues and proposes a change, ranked by points lost × expected gain. Nothing
        is applied automatically.
      </p>
      {!current ? (
        <p className="mt-6 rounded-xl border border-line p-6 text-center text-[14px] text-muted">
          No critiques yet. Record a run with{" "}
          <code className="font-mono text-[13px]">uv run python -m evals.history</code> or run{" "}
          <code className="font-mono text-[13px]">uv run python -m evals.critique</code>.
        </p>
      ) : (
        <div className="mt-6 grid grid-cols-[1fr_260px] gap-6">
          <div>
            <div className="mb-3 text-[13px] text-muted">
              {current.shortfalls.length} shortfalls in {current.chats} chats · agent{" "}
              {modelLabel(current.agent_model)} · critic {modelLabel(current.critic_model)} ·{" "}
              <Link href={`/runs/${current.run_id}`} className="underline">open the run</Link>
            </div>
            <IssueList critique={current} />
          </div>
          <aside>
            <h2 className="mb-2 text-[13px] text-muted">Critiqued runs</h2>
            <ul className="flex flex-col gap-px">
              {all.map((c) => {
                const run = notes.get(c.run_id);
                return (
                  <li key={c.run_id}>
                    <Link
                      href={`/improvements?run=${c.run_id}`}
                      className={`block rounded-lg px-2.5 py-2 text-[13px] ${
                        c.run_id === current.run_id ? "bg-subtle" : "hover:bg-subtle"
                      }`}
                    >
                      <div>{(run?.date ?? c.created).slice(0, 16)}</div>
                      <div className="truncate text-faint">
                        {run?.note || `${c.issues.length} issues`}
                      </div>
                    </Link>
                  </li>
                );
              })}
            </ul>
          </aside>
        </div>
      )}
    </>
  );
}
