"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { Activity, Database, LogOut, TrendingUp, Users } from "@/components/icons";
import { Logo } from "@/components/Logo";

const NAV = [
  { href: "/", label: "Runs", icon: Activity },
  { href: "/improvements", label: "Improvements", icon: TrendingUp },
  { href: "/feedback", label: "Feedback", icon: Users },
  { href: "/tests", label: "Tests", icon: Database },
];

export function Sidebar({ name, todo }: { name: string; todo: number | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const active = (href: string) =>
    href === "/" ? pathname === "/" || pathname.startsWith("/runs") : pathname.startsWith(href);

  return (
    <aside className="flex h-full w-[240px] shrink-0 flex-col border-r border-line bg-canvas px-3 py-4">
      <div className="mb-6 flex items-center gap-2.5 px-2">
        <Logo className="h-[18px] w-[18px]" />
        <span className="font-serif text-[17px]">Helios Evals</span>
      </div>
      <nav className="flex flex-col gap-px">
        {NAV.map(({ href, label, icon: Icon }) => (
          <Link
            key={href}
            href={href}
            className={`flex h-9 items-center gap-2.5 rounded-lg px-2.5 text-[14px] transition-colors ${
              active(href) ? "bg-subtle text-ink" : "text-muted hover:bg-subtle hover:text-ink"
            }`}
          >
            <Icon size={16} />
            <span className="flex-1">{label}</span>
            {href === "/feedback" && todo ? (
              <span className="rounded-full bg-sky px-1.5 text-[12px] text-sky-ink">{todo}</span>
            ) : null}
          </Link>
        ))}
      </nav>
      <div className="mt-auto flex items-center gap-2 px-2.5 text-[13px] text-muted">
        <span className="min-w-0 flex-1 truncate">{name}</span>
        <button
          type="button"
          aria-label="Sign out"
          title="Sign out"
          onClick={async () => {
            await fetch("/api/auth/logout", { method: "POST" });
            router.replace("/login");
          }}
          className="flex h-8 w-8 items-center justify-center rounded-full hover:bg-subtle hover:text-ink"
        >
          <LogOut size={15} />
        </button>
      </div>
    </aside>
  );
}
