export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const grade = (v: number) => v.toFixed(2);
export const usd = (v: number) => `$${v.toFixed(v < 0.1 ? 3 : 2)}`;

export function delta(now: number | null, before: number | null, fmt: (v: number) => string) {
  if (now === null || before === null) return null;
  const d = now - before;
  if (Math.abs(d) < 1e-9) return "no change";
  return `${d > 0 ? "+" : "−"}${fmt(Math.abs(d))} vs previous`;
}

/** By name, so a server component can choose one for a client chart. */
export const seconds = (v: number) => `${v.toFixed(0)}s`;
export const whole = (v: number) => v.toFixed(0);
export const FORMATS = { pct, grade, usd, seconds, whole };
export type FormatName = keyof typeof FORMATS;
