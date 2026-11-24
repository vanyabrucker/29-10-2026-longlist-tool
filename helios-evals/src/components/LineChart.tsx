"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FORMATS, type FormatName } from "@/lib/format";

export type Point = { t: number; label: string; value: number; note: string; href: string };
export type Series = { key: string; label: string; color: string; points: Point[] };

const W = 520;
const H = 180;
const PAD = { top: 12, right: 16, bottom: 26, left: 44 };

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/**
 * Runs in order (oldest left), one line per agent·judge pair in its own colour (the pair
 * list above the charts is the legend). Hover a point for the run's date,
 * pair, note and value; a click opens the run. `domain` "auto" starts at 0
 * and leaves headroom above the highest value.
 */
export function LineChart({
  title,
  series,
  domain,
  format: formatName,
}: {
  title: string;
  series: Series[];
  domain: [number, number] | "auto";
  format: FormatName;
}) {
  const format = FORMATS[formatName];
  const router = useRouter();
  const [hover, setHover] = useState<{ s: number; i: number } | null>(null);
  const all = series.flatMap((s) => s.points);
  const [lo, hi] =
    domain === "auto" ? [0, Math.max(...all.map((p) => p.value), 0) * 1.15 || 1] : domain;
  // Runs in order, evenly spaced (on a time axis they bunch up within a day
  // and leave gaps between days), one slot per run across the lines shown.
  const times = [...new Set(all.map((p) => p.t))].sort((a, b) => a - b);
  const slot = new Map(times.map((t, i) => [t, i]));
  const t0 = times[0];
  const t1 = times[times.length - 1];
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const x = (t: number) =>
    PAD.left + (times.length < 2 ? innerW / 2 : ((slot.get(t) ?? 0) / (times.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - ((v - lo) / (hi - lo || 1)) * innerH;
  const ticks = [lo, lo + (hi - lo) / 2, hi];
  const first = series[0]?.points;
  const shown = hover ? series[hover.s].points[hover.i] : null;

  return (
    <figure className="rounded-xl border border-line bg-white p-4">
      <figcaption className="mb-2 flex items-baseline justify-between gap-3">
        <span className="text-[14px] font-medium">{title}</span>
        {first && first.length > 0 && (
          <span className="text-[13px] text-muted">latest {format(first[first.length - 1].value)}</span>
        )}
      </figcaption>
      {all.length === 0 ? (
        <p className="py-10 text-center text-[13px] text-faint">No runs with this score yet.</p>
      ) : (
        <div className="relative">
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            role="img"
            aria-label={`${title}: ${series
              .map((s) => `${s.label} ${s.points.map((p) => format(p.value)).join(", ")}`)
              .join("; ")}`}
            onMouseLeave={() => setHover(null)}
          >
            {ticks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} x2={W - PAD.right} y1={y(t)} y2={y(t)} stroke="#f3f4f6" />
                <text x={PAD.left - 8} y={y(t) + 4} textAnchor="end" fontSize="11" fill="#9a9aa0">
                  {format(t)}
                </text>
              </g>
            ))}
            {shown && (
              <line x1={x(shown.t)} x2={x(shown.t)} y1={PAD.top} y2={PAD.top + innerH} stroke="#e7e7e9" />
            )}
            {series.map((s) => (
              <polyline
                key={s.key}
                fill="none"
                stroke={s.color}
                strokeWidth="2"
                strokeLinejoin="round"
                points={s.points.map((p) => `${x(p.t)},${y(p.value)}`).join(" ")}
              />
            ))}
            {series.map((s, si) =>
              s.points.map((p, i) => {
                const on = hover?.s === si && hover.i === i;
                return (
                  <g key={`${s.key}-${i}`}>
                    <circle cx={x(p.t)} cy={y(p.value)} r={on ? 5 : 4} fill={s.color}
                      stroke="#ffffff" strokeWidth="2" />
                    {/* Hit target, larger than the marker. */}
                    <circle
                      cx={x(p.t)}
                      cy={y(p.value)}
                      r={10}
                      fill="transparent"
                      className="cursor-pointer"
                      onMouseEnter={() => setHover({ s: si, i })}
                      onClick={() => router.push(p.href)}
                    />
                  </g>
                );
              }),
            )}
            <text x={PAD.left} y={H - 6} fontSize="11" fill="#9a9aa0">{day(t0)}</text>
            {t1 !== t0 && (
              <text x={W - PAD.right} y={H - 6} fontSize="11" fill="#9a9aa0" textAnchor="end">
                {day(t1)}
              </text>
            )}
          </svg>
          {shown && hover && (
            <div
              className="pointer-events-none absolute top-0 z-10 w-max max-w-[280px] -translate-x-1/2 rounded-lg bg-ink px-2.5 py-1.5 text-[12px] text-white"
              style={{ left: `${(x(shown.t) / W) * 100}%` }}
            >
              <div className="flex items-center gap-1.5 font-medium">
                <span className="h-2 w-2 rounded-full" style={{ background: series[hover.s].color }} />
                {format(shown.value)}
              </div>
              <div className="text-white/70">{series[hover.s].label}</div>
              <div className="text-white/70">{shown.label}</div>
              {shown.note && <div className="mt-0.5 text-white/90">{shown.note}</div>}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}
