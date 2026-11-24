import { requireDev } from "@/lib/gatewayServer";
import { dataset, scenarios, type Scenario } from "@/lib/data";

const BEHAVIOUR: Record<string, string> = {
  missing_data_on_filter: "Filtering with unknown values: keep and flag, don't drop",
  fit_scoring: "Fit scores and rationales per Helbling's criteria",
};

export default async function TestsPage() {
  // Pages render alongside the layout, so each checks on its own.
  await requireDev();
  const [all, replays] = await Promise.all([scenarios(), dataset()]);
  return (
    <>
      <h1 className="font-serif text-[28px]">Tests</h1>
      <p className="mt-1 text-[14px] text-muted">
        {all.length} hand-written scenarios with known answers (
        <code className="font-mono text-[13px]">evals/scenarios/</code>) and {replays.length}{" "}
        real chats in the replay dataset.
      </p>

      <h2 className="mt-8 mb-3 text-[16px] font-medium">Scenarios</h2>
      <div className="flex flex-col gap-3">
        {all.map((s) => (
          <ScenarioCard key={s.id} s={s} />
        ))}
      </div>

      <h2 className="mt-10 mb-1 text-[16px] font-medium">Replay dataset</h2>
      <p className="mb-3 text-[13px] text-muted">
        <code className="font-mono text-[13px]">evals/data/dataset.jsonl</code> (local). Add chats
        from the Feedback page or with{" "}
        <code className="font-mono text-[13px]">uv run python -m evals.dataset export --chat ID --append</code>.
      </p>
      {replays.length === 0 ? (
        <p className="rounded-xl border border-line p-6 text-center text-[14px] text-muted">
          No chats exported yet.
        </p>
      ) : (
        <div className="overflow-hidden rounded-xl border border-line">
          <table className="w-full text-[13px]">
            <thead className="bg-canvas text-left text-muted">
              <tr>
                {["Chat", "First message", "Messages", "Lists built"].map((h) => (
                  <th key={h} className="px-3 py-2 font-normal">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {replays.map((r) => (
                <tr key={r.id} className="border-t border-hairline align-top">
                  <td className="px-3 py-2">
                    <div>{r.title || "Untitled"}</div>
                    <div className="font-mono text-[11px] text-faint">{r.id}</div>
                  </td>
                  <td className="max-w-[520px] px-3 py-2 text-muted">
                    <div className="line-clamp-3">{r.input}</div>
                  </td>
                  <td className="px-3 py-2">{r.messages?.length ?? 1}</td>
                  <td className="px-3 py-2">
                    {(r.original?.lists ?? []).map((l) => `${l.name} (${l.rows.length})`).join(", ") || "–"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function ScenarioCard({ s }: { s: Scenario }) {
  const rows = s.setup?.list?.rows ?? [];
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const expect = s.expect ?? {};
  const keepFlagDrop = ["keep", "flag", "drop"].filter((k) => Array.isArray(expect[k]));
  const checks = (expect.rows ?? {}) as Record<string, Record<string, unknown>>;
  const webAnswers = s.answers?.web_research?.map((a) => a.answer) ?? [];

  return (
    <details className="group rounded-xl border border-line">
      <summary className="flex cursor-pointer items-start gap-3 p-4">
        <div className="min-w-0 flex-1">
          <div className="text-[15px] font-medium">{s.title ?? s.id}</div>
          <div className="mt-0.5 text-[13px] text-muted">
            {BEHAVIOUR[s.behaviour ?? ""] ?? s.behaviour} ·{" "}
            <span className="font-mono text-[12px]">{s.file}</span> · {s.id}
          </div>
        </div>
        <span className="text-[12px] text-faint group-open:hidden">Show</span>
      </summary>
      <div className="border-t border-line p-4 text-[13px]">
        <div className="text-muted">The user says</div>
        <p className="mt-1 whitespace-pre-wrap">{s.input}</p>

        {rows.length > 0 && (
          <>
            <div className="mt-4 text-muted">
              Starting list: {s.setup?.list?.name} ({s.setup?.list?.kind}); “–” is unknown
            </div>
            <div className="mt-1.5 overflow-x-auto rounded-lg border border-line">
              <table className="w-full">
                <thead className="bg-canvas text-left text-muted">
                  <tr>{cols.map((c) => <th key={c} className="px-2.5 py-1.5 font-normal">{c}</th>)}</tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={i} className="border-t border-hairline">
                      {cols.map((c) => (
                        <td key={c} className="px-2.5 py-1.5">
                          {r[c] === undefined ? <span className="text-faint">–</span> : String(r[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="mt-4 text-muted">Web search</div>
        <p className="mt-1">
          {webAnswers.length ? `Approved (“${webAnswers.join("”, then “")}”)` : "Refused (“No”) if asked"}
          {s.setup?.web?.length
            ? `; its own pages for ${s.setup.web.map((w) => `“${w.match}”`).join(", ")}`
            : ""}
        </p>
        {s.setup?.web?.map((w) =>
          w.results.map((r, i) => (
            <div key={`${w.match}-${i}`} className="mt-1.5 rounded-lg bg-canvas px-3 py-2">
              <div>{r.title}</div>
              <div className="text-faint">{r.url}</div>
              {r.highlights?.map((h, j) => <div key={j} className="mt-0.5 text-muted">{h}</div>)}
            </div>
          )),
        )}

        <div className="mt-4 text-muted">Expected</div>
        <ul className="mt-1 flex flex-col gap-1">
          {keepFlagDrop.map((k) => (
            <li key={k}>
              <span className="text-muted">{k[0].toUpperCase() + k.slice(1)}: </span>
              {(expect[k] as string[]).join(", ")}
            </li>
          ))}
          {Object.entries(checks).map(([name, spec]) => (
            <li key={name}>
              <span className="text-muted">{name}: </span>
              {[
                spec.missing && "inputs missing: says so, not scored 0",
                spec.not_excluded && "kept with a score above 0",
                spec.flag && "group overlap mentioned",
                Array.isArray(spec.mentions) && `names its criteria (${(spec.mentions as string[]).length})`,
              ].filter(Boolean).join("; ")}
            </li>
          ))}
          {Array.isArray(expect.better) &&
            (expect.better as [string, string][]).map(([a, b]) => (
              <li key={`${a}>${b}`}><span className="text-muted">Ranked higher: </span>{a} over {b}</li>
            ))}
          {Boolean(expect.ask_web) && <li>Offers to search the web for missing inputs</li>}
          {s.behaviour === "fit_scoring" && <li>Calls out facts from weaker sources (web, no source)</li>}
        </ul>
      </div>
    </details>
  );
}
