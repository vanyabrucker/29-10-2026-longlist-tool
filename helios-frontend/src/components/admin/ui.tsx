"use client";

// Small building blocks for the dev-only admin area (English only: it's an
// internal tool, not part of the translated product UI).

import Link from "next/link";
import { ArrowLeft } from "react-feather";
import type { ImportStatus } from "@/lib/gateway";

export function Page({
  title,
  back,
  actions,
  children,
}: {
  title: string;
  back?: { href: string; label: string };
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-tl-xl border-t border-l border-line bg-white">
      <div className="min-h-0 flex-1 overflow-y-auto px-8 pt-8 pb-16">
        {back && (
          <Link
            href={back.href}
            className="mb-3 inline-flex items-center gap-1.5 text-[13px] text-muted transition-colors hover:text-ink"
          >
            <ArrowLeft size={14} strokeWidth={1.75} />
            {back.label}
          </Link>
        )}
        <div className="flex items-start justify-between gap-4">
          <h1 className="min-w-0 truncate font-serif text-[28px] leading-tight tracking-[-0.01em]">
            {title}
          </h1>
          {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
        </div>
        <div className="mt-6 space-y-8">{children}</div>
      </div>
    </div>
  );
}

export function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2.5 flex items-baseline justify-between gap-4">
        <h2 className="text-[15px] font-medium">{title}</h2>
        {aside && <div className="text-[13px] text-muted">{aside}</div>}
      </div>
      {children}
    </section>
  );
}

export function Button({
  variant = "secondary",
  className = "",
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost";
}) {
  const styles = {
    primary: "bg-ink text-white hover:bg-[#26262a] disabled:bg-[#c4c4c8]",
    secondary:
      "border border-line bg-white hover:bg-subtle disabled:text-faint disabled:hover:bg-white",
    ghost: "text-muted hover:bg-subtle hover:text-ink disabled:text-faint",
  }[variant];
  return (
    <button
      type="button"
      {...props}
      className={`inline-flex h-8 items-center justify-center gap-1.5 rounded-lg px-3 text-[13.5px] font-medium whitespace-nowrap transition-colors disabled:cursor-default ${styles} ${className}`}
    />
  );
}

// Neutral pills with a status dot in the existing palette (no new colours).
const STATUS: Record<ImportStatus, { label: string; dot: string }> = {
  uploaded: { label: "Uploaded", dot: "bg-faint" },
  analysing: { label: "Analysing", dot: "bg-sky-ink animate-pulse" },
  remapping: { label: "Re-mapping", dot: "bg-sky-ink animate-pulse" },
  mapping_review: { label: "Review mapping", dot: "bg-warn" },
  building_report: {
    label: "Building report",
    dot: "bg-sky-ink animate-pulse",
  },
  report_review: { label: "Review report", dot: "bg-warn" },
  committing: { label: "Committing", dot: "bg-sky-ink animate-pulse" },
  committed: { label: "Committed", dot: "bg-good" },
  failed: { label: "Failed", dot: "bg-bad" },
  cancelled: { label: "Cancelled", dot: "bg-faint" },
};

export function StatusPill({ status }: { status: ImportStatus }) {
  const s = STATUS[status] ?? STATUS.uploaded;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md bg-subtle px-1.5 py-0.5 text-[12px] font-medium whitespace-nowrap">
      <span className={`size-1.5 rounded-full ${s.dot}`} />
      {s.label}
    </span>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  tone?: "info" | "warn" | "error";
  children: React.ReactNode;
}) {
  const dot = { info: "bg-sky-ink", warn: "bg-warn", error: "bg-bad" }[tone];
  return (
    <div className="flex gap-2.5 rounded-lg border border-line bg-canvas px-3 py-2 text-[13.5px]">
      <span className={`mt-[7px] size-1.5 shrink-0 rounded-full ${dot}`} />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export const inputClass =
  "h-8 rounded-lg border border-line bg-white px-2.5 text-[13.5px] outline-none transition-shadow focus:border-[#c9d9ef] focus:ring-3 focus:ring-sky";

export const th =
  "border-b border-line px-3 py-2 text-left text-[12.5px] font-normal whitespace-nowrap text-muted";
export const td = "border-b border-hairline px-3 py-2 align-top";

export function formatWhen(iso: string | null) {
  if (!iso) return "–";
  return new Date(iso).toLocaleString("en-GB", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatEta(seconds: number | null) {
  if (seconds === null) return "estimating…";
  if (seconds < 60) return `about ${Math.max(1, seconds)}s left`;
  return `about ${Math.round(seconds / 60)} min left`;
}
