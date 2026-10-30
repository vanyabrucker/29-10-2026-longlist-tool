"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { memo, useCallback, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Book,
  Briefcase,
  Folder,
  Home,
  LogOut,
  Plus,
  Settings,
  Sidebar as SidebarIcon,
} from "react-feather";
import { signOut } from "@/lib/auth";
import { useChatList } from "@/lib/chat";
import { useDismiss } from "@/lib/useDismiss";
import { Logo } from "./Logo";

const NAV = [
  { label: "Home", icon: Home, href: "/" },
  { label: "Companies", icon: Briefcase },
  { label: "Contacts", icon: Book },
];

const SAMPLE_RECENTS: { title: string; live?: boolean }[] = [
  { title: "Nordic Cold Chain Logistics Targets", live: true },
  { title: "Bavarian Precision Machining Buyers" },
  { title: "UK Veterinary Clinic Roll-up Pipeline" },
  { title: "Benelux Specialty Chemicals Carve-outs" },
  { title: "Family-owned Packaging Succession Targets" },
  { title: "Mid-market PE Funds Active in Fintech" },
  { title: "Iberian Renewable Energy Developers" },
  { title: "Strategic Acquirers for HR SaaS Platform" },
  { title: "Austrian Dental Lab Consolidation" },
  { title: "French Aerospace Tier-2 Supplier Longlist" },
  { title: "Swiss Wealth Management Boutiques" },
  { title: "Buy-side Comps: Industrial IoT 2026" },
  { title: "Founder-led Cybersecurity Firms DACH" },
  { title: "Polish Food Ingredients Add-on Targets", live: true },
  { title: "Family Offices Investing in Healthcare" },
  { title: "Precedent Transactions: Testing & Inspection" },
  { title: "Scandinavian EdTech Exit Candidates" },
  { title: "Italian Luxury Leather Goods Suppliers" },
  { title: "Infrastructure Funds Seeking Fibre Assets" },
  { title: "Dutch Facility Services Buy-and-Build" },
  { title: "Management Contacts: Auto Parts Distributors" },
  { title: "Secondary Buyout Candidates Q1 2027" },
];

const itemClass =
  "flex h-8 w-full items-center gap-2.5 overflow-hidden rounded-lg px-2 text-left text-[14px] whitespace-nowrap text-ink transition-colors hover:bg-subtle";

const EXPANDED = 228;
const COLLAPSED = 52;

export const Sidebar = memo(function Sidebar({ user }: { user: string }) {
  const pathname = usePathname();
  const conversations = useChatList();
  const [collapsed, setCollapsed] = useState(false);
  // Sections that only make sense with labels fade out in the collapsed rail.
  const fade = `transition-opacity duration-200 ${collapsed ? "pointer-events-none opacity-0" : "opacity-100 delay-100"}`;

  return (
    <aside
      style={{ width: collapsed ? COLLAPSED : EXPANDED }}
      className="h-full shrink-0 overflow-hidden bg-canvas transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
    >
      {/* Content keeps its full width and is clipped, so labels never reflow mid-animation. */}
      <div className="flex h-full flex-col" style={{ width: EXPANDED }}>
        <div className="flex h-[50px] items-center justify-between pr-3 pl-[11px]">
          {collapsed ? (
            <button
              type="button"
              aria-label="Open sidebar"
              onClick={() => setCollapsed(false)}
              className="group relative flex size-[30px] items-center justify-center rounded-lg text-[#5d5d63] transition-colors hover:bg-subtle"
            >
              <Logo className="size-[16px] transition-all duration-200 group-hover:scale-75 group-hover:opacity-0" />
              <SidebarIcon
                size={16}
                strokeWidth={1.75}
                className="absolute scale-75 opacity-0 transition-all duration-200 group-hover:scale-100 group-hover:opacity-100"
              />
            </button>
          ) : (
            <Link
              href="/"
              aria-label="Helios home"
              className="flex size-[30px] items-center justify-center"
            >
              <Logo className="size-[16px]" />
            </Link>
          )}
          <button
            type="button"
            aria-label="Collapse sidebar"
            onClick={() => setCollapsed(true)}
            tabIndex={collapsed ? -1 : 0}
            className={`rounded-md p-1 text-[#5d5d63] hover:bg-subtle ${fade}`}
          >
            <SidebarIcon size={16} strokeWidth={1.75} />
          </button>
        </div>

        <nav
          style={{ width: collapsed ? COLLAPSED : EXPANDED }}
          className="px-[11px] pt-1.5 transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
        >
          {NAV.map(({ label, icon: Icon, href }) => {
            const active = href === pathname;
            const content = (
              <>
                <Icon size={14} strokeWidth={1.75} className="shrink-0" />
                <span className={active ? "font-medium" : undefined}>
                  {label}
                </span>
              </>
            );
            return href ? (
              <Link
                key={label}
                href={href}
                className={`${itemClass} ${active ? "bg-[#ececee] hover:bg-[#ececee]" : ""}`}
              >
                {content}
              </Link>
            ) : (
              <button key={label} type="button" className={itemClass}>
                {content}
              </button>
            );
          })}
        </nav>

        <div className={`flex min-h-0 flex-1 flex-col ${fade}`}>
          <div className="mt-5 flex items-center justify-between pr-3 pl-[17px] text-[12.5px] text-muted">
            Projects
            <Plus
              size={14}
              strokeWidth={1.75}
              className="cursor-pointer text-faint hover:text-ink"
            />
          </div>
          <div className="px-[11px] pt-1.5">
            <button type="button" className={`${itemClass} pl-2.5`}>
              <Folder
                size={14}
                strokeWidth={1.75}
                className="shrink-0 text-sky-ink"
              />
              <span className="truncate">Helios sample workspace</span>
            </button>
          </div>

          <div className="mt-5 pl-[17px] text-[12.5px] text-muted">Recents</div>
          <ul className="mt-1.5 min-h-0 flex-1 overflow-y-auto px-[11px] pb-2 [scrollbar-width:none]">
            {conversations.map((c) => {
              const href = `/c/${c.id}`;
              return (
                <li key={c.id}>
                  <Link
                    href={href}
                    className={`${itemClass} h-8 ${pathname === href ? "bg-[#ececee] hover:bg-[#ececee]" : ""}`}
                  >
                    <span className="truncate">{c.title}</span>
                  </Link>
                </li>
              );
            })}
            {SAMPLE_RECENTS.map((r) => (
              <li key={r.title}>
                <button type="button" className={itemClass}>
                  {r.live && (
                    <span className="size-[7px] shrink-0 rounded-full bg-[#f08a24]" />
                  )}
                  <span className="truncate">{r.title}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        <div className="flex h-12 items-center px-[11px]">
          <UserMenu user={user} collapsed={collapsed} fade={fade} />
        </div>
      </div>
    </aside>
  );
});

function UserMenu({
  user,
  collapsed,
  fade,
}: {
  user: string;
  collapsed: boolean;
  fade: string;
}) {
  const router = useRouter();
  const [anchor, setAnchor] = useState<{ left: number; bottom: number } | null>(
    null,
  );
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setAnchor(null), []);
  useDismiss(ref, anchor !== null, close);

  function toggle(e: React.MouseEvent<HTMLButtonElement>) {
    if (anchor) return close();
    // Fixed position so the menu isn't clipped by the collapsed sidebar.
    const rect = e.currentTarget.getBoundingClientRect();
    setAnchor({ left: rect.left, bottom: window.innerHeight - rect.top + 6 });
  }

  const item =
    "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] transition-colors hover:bg-subtle";

  return (
    <div ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        onClick={toggle}
        style={{ width: collapsed ? 30 : EXPANDED - 22 }}
        className={`flex h-9 items-center gap-2 overflow-hidden rounded-lg px-[5px] text-left transition-[width,background-color] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-subtle ${anchor ? "bg-subtle" : ""}`}
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-sky text-[10px] font-medium text-[#41526b]">
          {user[0]?.toUpperCase()}
        </span>
        <span className={`min-w-0 flex-1 truncate text-[13px] ${fade}`}>
          {user}
        </span>
      </button>

      <AnimatePresence>
        {anchor && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.96, y: 4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            style={{ left: anchor.left, bottom: anchor.bottom }}
            className="fixed z-30 w-[206px] origin-bottom-left rounded-xl border border-line bg-white p-1 shadow-[0_4px_20px_rgba(0,0,0,0.08)]"
          >
            <button
              type="button"
              role="menuitem"
              onClick={close}
              className={item}
            >
              <Settings
                size={15}
                strokeWidth={1.75}
                className="text-[#5d5d63]"
              />
              Settings
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                signOut();
                router.replace("/login");
              }}
              className={item}
            >
              <LogOut size={15} strokeWidth={1.75} className="text-[#5d5d63]" />
              Sign out
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
