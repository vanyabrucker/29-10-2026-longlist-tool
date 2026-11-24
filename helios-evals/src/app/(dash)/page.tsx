import Link from "next/link";
import { Check, Plus } from "@/components/icons";
import { LineChart, type Series } from "@/components/LineChart";
import { num, pairOf, runs, type Run } from "@/lib/data";
import { delta, grade, pct, usd, type FormatName } from "@/lib/format";
import { requireDev } from "@/lib/gatewayServer";
import { pairLabel } from "@/lib/models";

const CHARTS: { key: string; title: string; domain: [number, number] | "auto"; format: FormatName }[] = [
  { key: "scoring_passed", title: "Buyer scoring: chats passing every check", domain: [0, 1], format: "pct" },
  { key: "scoring_judge_mean", title: "Buyer scoring: judge mean", domain: [1, 5], format: "grade" },
  { key: "transparency", title: "Buyer scoring: weak sources disclosed", domain: [1, 5], format: "grade" },
  { key: "passed", title: "Filtering: chats passing every check", domain: [0, 1], format: "pct" },
  { key: "cost_usd", title: "Cost per chat (agent, USD)", domain: "auto", format: "usd" },
  { key: "wall_s", title: "Speed: seconds per chat", domain: "auto", format: "seconds" },
  { key: "output_tokens_per_s", title: "Speed: output tokens per second", domain: "auto", format: "whole" },
];

const TILES: { key: string; label: string; format: (v: number) => string }[] = [
  { key: "scoring_passed", label: "Scoring checks passed", format: pct },
  { key: "scoring_judge_mean", label: "Scoring judge mean", format: grade },
  { key: "passed", label: "Filter checks passed", format: pct },
  { key: "cost_usd", label: "Cost per chat", format: usd },
  { key: "wall_s", label: "Seconds per chat", format: (v) => `${v.toFixed(1)}s` },
];

// The validated categorical order (dataviz reference palette, light mode);
// a pair keeps its slot by when it first ran. A 9th pair and later share grey.
const COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const OTHER = "#9a9aa0";

const list = (v: string | string[] | undefined) => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** The page with `pair` selected and `show` in the charts. An empty `show`
 * is kept as one empty value, so "nothing in the charts" survives the URL. */
function href(pair: string, show: string[]) {
  const q = new URLSearchParams({ pair });
  for (const p of show.length ? show : [""]) q.append("show", p);
  return `/?${q}`;
}

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ pair?: string; show?: string | string[] }>;
}) {
  // Pages render alongside the layout, so each checks on its own.
  await requireDev();
  const params = await searchParams;
  const all = (await runs()).filter(
    (r) => r.task === "helios_scenarios" && r.status === "success",
  );
  const byAge = [...new Set(all.map(pairOf))]; // oldest first: colour slots
  const color = new Map(byAge.map((p, i) => [p, COLORS[i] ?? OTHER]));
  const labels = new Map(all.map((r) => [pairOf(r), pairLabel(r.agent_model, r.judge_model)]));
  const newest = [...byAge].reverse(); // by first run, newest first
  const pair = params.pair ?? [...new Set([...all].reverse().map(pairOf))][0];
  // In the charts: as chosen, else just the selected pair.
  const show =
    params.show === undefined ? [pair] : list(params.show).filter((p) => color.has(p));
  const shown = all.filter((r) => pairOf(r) === pair);
  const latest = shown.at(-1);
  const previous = shown.at(-2);

  const series = (key: string): Series[] =>
    newest.filter((p) => show.includes(p)).map((p) => ({
      key: p,
      label: labels.get(p) ?? p,
      color: color.get(p) ?? OTHER,
      points: all
        .filter((r) => pairOf(r) === p)
        .flatMap((r) => {
          const v = num(r[key]);
          // A run without a price for its model records cost 0: leave it out.
          const unknown = key === "cost_usd" && num(r.cost_known) === 0;
          return v === null || unknown
            ? []
            : [{ t: Date.parse(`${r.date.replace(" ", "T")}Z`), value: v,
                 label: `${r.date.slice(0, 16)} · ${r.git_commit || "no commit"}`,
                 note: r.note, href: `/runs/${r.run_id}` }];
        }),
    }));

  return (
    <>
      <h1 className="font-serif text-[28px]">Runs</h1>
      <p className="mt-1 text-[14px] text-muted">
        Scenario runs (<code className="font-mono text-[13px]">helios_scenarios</code>) from{" "}
        <code className="font-mono text-[13px]">evals/history/runs.csv</code>. Runs only compare
        within one agent and judge model.
      </p>

      <div className="mt-5 flex flex-wrap gap-2">
        {newest.map((p) => {
          const selected = p === pair;
          const on = show.includes(p);
          return (
            <div
              key={p}
              className={`flex h-8 max-w-full items-center rounded-full border bg-white text-[13px] whitespace-nowrap ${
                selected ? "border-ink text-ink" : "border-line text-muted"
              }`}
            >
              <Link
                href={href(p, on ? show : [...show, p])}
                aria-current={selected ? "true" : undefined}
                className="flex h-full min-w-0 items-center gap-2 rounded-l-full pl-3 pr-1.5 hover:text-ink"
              >
                <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color.get(p) }} />
                <span className="truncate">{labels.get(p) ?? p}</span>
              </Link>
              <Link
                href={href(pair, on ? show.filter((x) => x !== p) : [...show, p])}
                aria-pressed={on}
                aria-label={on ? "Remove from the charts" : "Add to the charts"}
                className="mr-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted hover:bg-subtle hover:text-ink"
              >
                {on ? <Check size={14} /> : <Plus size={14} />}
              </Link>
            </div>
          );
        })}
      </div>

      {latest && (
        <section className="mt-6 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
          {TILES.map((t) => {
            const v = num(latest[t.key]);
            return (
              <div key={t.key} className="rounded-xl border border-line p-4">
                <div className="text-[13px] text-muted">{t.label}</div>
                <div className="mt-1 font-serif text-[26px]">{v === null ? "–" : t.format(v)}</div>
                <div className="text-[12px] text-faint">
                  {t.key === "cost_usd" && num(latest.cost_known) === 0
                    ? "no price set for this model"
                    : (delta(v, num(previous?.[t.key]), t.format) ?? "first run")}
                </div>
              </div>
            );
          })}
        </section>
      )}

      <section className="mt-4 grid grid-cols-1 gap-3 lg:grid-cols-2">
        {CHARTS.map((c) => (
          <LineChart key={c.key} title={c.title} series={series(c.key)} domain={c.domain}
            format={c.format} />
        ))}
      </section>

      <h2 className="mt-8 mb-3 text-[16px] font-medium">All runs of this pair</h2>
      <RunsTable rows={[...shown].reverse()} />
    </>
  );
}

function RunsTable({ rows }: { rows: Run[] }) {
  const cell = (r: Run, key: string, f: (v: number) => string) => {
    const v = num(r[key]);
    return v === null ? "–" : f(v);
  };
  return (
    <div className="overflow-hidden rounded-xl border border-line">
      <table className="w-full text-[13px]">
        <thead className="bg-canvas text-left text-muted">
          <tr>
            {["When", "Commit", "Note", "Chats", "Scoring passed", "Judge mean", "Filters passed",
              "Infra broken"].map((h) => (
              <th key={h} className="px-3 py-2 font-normal">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.run_id} className="border-t border-hairline hover:bg-canvas">
              <td className="whitespace-nowrap px-3 py-2">
                <Link href={`/runs/${r.run_id}`} className="hover:underline">
                  {r.date.slice(0, 16)}
                </Link>
              </td>
              <td className="px-3 py-2 font-mono text-[12px] text-muted">
                {r.git_commit}{r.git_dirty === "dirty" ? "*" : ""}
              </td>
              <td className="max-w-[380px] px-3 py-2 text-muted">{r.note}</td>
              <td className="px-3 py-2">{Number(r.samples) * Number(r.epochs)}</td>
              <td className="px-3 py-2">{cell(r, "scoring_passed", pct)}</td>
              <td className="px-3 py-2">{cell(r, "scoring_judge_mean", grade)}</td>
              <td className="px-3 py-2">{cell(r, "passed", pct)}</td>
              <td className="px-3 py-2">{cell(r, "infra_broken", pct)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
