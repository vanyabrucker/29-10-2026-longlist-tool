"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { memo, useCallback, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  Briefcase,
  Home,
  LogOut,
  Settings,
  Sidebar as SidebarIcon,
  Table,
  User,
  Users,
} from "react-feather";
import { signOut } from "@/lib/auth";
import { useChatList } from "@/lib/chat";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { useDismiss } from "@/lib/useDismiss";
import { Logo } from "./Logo";

const NAV: { label: MessageKey; icon: typeof Home; href?: string }[] = [
  { label: "Home", icon: Home, href: "/" },
  { label: "Companies", icon: Briefcase, href: "/companies" },
  { label: "Longlists", icon: Table, href: "/longlists" },
];

const SAMPLE_RECENTS: { title: string }[] = [
  { title: "Nordic Cold Chain Logistics Targets" },
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
  { title: "Polish Food Ingredients Add-on Targets" },
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

const SLIDE = { duration: 0.4, ease: [0.32, 0.72, 0, 1] } as const;

const SETTINGS_NAV: { label: MessageKey; icon: typeof Home; href: string }[] = [
  { label: "Profile", icon: User, href: "/settings/profile" },
  { label: "Members", icon: Users, href: "/settings/members" },
];

const EXPANDED = 228;
const COLLAPSED = 52;

export const Sidebar = memo(function Sidebar({ user }: { user: string }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const conversations = useChatList();
  const [collapsed, setCollapsed] = useState(false);
  const inSettings = pathname.startsWith("/settings");
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
              aria-label={t("Open sidebar")}
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
              aria-label={t("Helios home")}
              className="flex size-[30px] items-center justify-center"
            >
              <Logo className="size-[16px]" />
            </Link>
          )}
          <button
            type="button"
            aria-label={t("Collapse sidebar")}
            onClick={() => setCollapsed(true)}
            tabIndex={collapsed ? -1 : 0}
            className={`rounded-md p-1 text-[#5d5d63] hover:bg-subtle ${fade}`}
          >
            <SidebarIcon size={16} strokeWidth={1.75} />
          </button>
        </div>

        {/* Settings slides in from the right, pushing the app nav out left. */}
        <div className="relative min-h-0 flex-1 overflow-hidden">
          <AnimatePresence initial={false}>
            {inSettings ? (
              <motion.div
                key="settings"
                initial={{ x: "100%" }}
                animate={{ x: 0 }}
                exit={{ x: "100%" }}
                transition={SLIDE}
                className="absolute inset-0 flex flex-col"
              >
                <SettingsNav pathname={pathname} fade={fade} />
              </motion.div>
            ) : (
              <motion.div
                key="app"
                initial={{ x: "-100%" }}
                animate={{ x: 0 }}
                exit={{ x: "-100%" }}
                transition={SLIDE}
                className="absolute inset-0 flex flex-col"
              >
                <nav
                  style={{ width: collapsed ? COLLAPSED : EXPANDED }}
                  className="px-[11px] pt-1.5 transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
                >
                  {NAV.map(({ label, icon: Icon, href }) => {
                    const active = href === pathname;
                    const content = (
                      <>
                        <Icon
                          size={14}
                          strokeWidth={1.75}
                          className="shrink-0"
                        />
                        <span className={active ? "font-medium" : undefined}>
                          {t(label)}
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
                  <div className="mt-5 pl-[17px] text-[12.5px] text-muted">
                    {t("Recents")}
                  </div>
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
                          <span className="truncate">{r.title}</span>
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="flex h-12 items-center px-[11px]">
          <UserMenu user={user} collapsed={collapsed} fade={fade} />
        </div>
      </div>
    </aside>
  );
});

// Back arrow (to home) beside the "Settings" title, then the settings pages.
// Icons sit where the app nav's icons do, so the rail looks the same.
function SettingsNav({ pathname, fade }: { pathname: string; fade: string }) {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <nav className="px-[11px] pt-1.5">
      <div className="flex h-8 items-center gap-1">
        <button
          type="button"
          aria-label={t("Back to app")}
          onClick={() => router.push("/")}
          className="-ml-px flex size-8 shrink-0 items-center justify-center rounded-lg text-[#3a3a3f] transition-colors hover:bg-subtle"
        >
          <ArrowLeft size={16} strokeWidth={1.75} />
        </button>
        <span
          className={`truncate font-serif text-[16px] font-medium whitespace-nowrap ${fade}`}
        >
          {t("Settings")}
        </span>
      </div>
      <div className="mt-2">
        {SETTINGS_NAV.map(({ label, icon: Icon, href }) => {
          const active =
            pathname === href ||
            (pathname === "/settings" && href === "/settings/profile");
          return (
            <Link
              key={href}
              href={href}
              className={`${itemClass} ${active ? "bg-[#ececee] hover:bg-[#ececee]" : ""}`}
            >
              <Icon size={14} strokeWidth={1.75} className="shrink-0" />
              <span className={active ? "font-medium" : undefined}>
                {t(label)}
              </span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
}

function UserMenu({
  user,
  collapsed,
  fade,
}: {
  user: string;
  collapsed: boolean;
  fade: string;
}) {
  const { t } = useI18n();
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
              onClick={() => {
                close();
                router.push("/settings/profile");
              }}
              className={item}
            >
              <Settings
                size={15}
                strokeWidth={1.75}
                className="text-[#5d5d63]"
              />
              {t("Settings")}
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
              {t("Sign out")}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
