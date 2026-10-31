"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  Briefcase,
  Edit2,
  Home,
  LogOut,
  MoreVertical,
  Settings,
  Sidebar as SidebarIcon,
  Table,
  Trash2,
  User,
  Users,
} from "react-feather";

/** Feather has no pushpin; angled thumbtack matching the product reference. */
function PinIcon({
  size = 15,
  strokeWidth = 1.75,
  className,
  filled,
}: {
  size?: number;
  strokeWidth?: number;
  className?: string;
  filled?: boolean;
}) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      {/* Drawn upright, then rotated so the needle points down-left. */}
      <g transform="rotate(45 12 12)">
        <path d="M12 15v7" />
        <path
          d="M9 2h6a1 1 0 0 1 1 1v2l-1.5 2v3.5L18 14v1H6v-1l3.5-3.5V7L8 5V3a1 1 0 0 1 1-1z"
          fill={filled ? "currentColor" : "none"}
        />
      </g>
    </svg>
  );
}
import { signOut } from "@/lib/auth";
import { useChatActions, useChatList } from "@/lib/chat";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { useDismiss } from "@/lib/useDismiss";
import { Logo } from "./Logo";

const NAV: { label: MessageKey; icon: typeof Home; href?: string }[] = [
  { label: "Home", icon: Home, href: "/" },
  { label: "Companies", icon: Briefcase, href: "/companies" },
  { label: "Longlists", icon: Table, href: "/longlists" },
];

type SampleRecent = {
  id: string;
  title: string;
  pinned?: boolean;
};

const SAMPLE_RECENTS_SEED: SampleRecent[] = [
  { id: "s1", title: "Nordic Cold Chain Logistics Targets" },
  { id: "s2", title: "Bavarian Precision Machining Buyers" },
  { id: "s3", title: "UK Veterinary Clinic Roll-up Pipeline" },
  { id: "s4", title: "Benelux Specialty Chemicals Carve-outs" },
  { id: "s5", title: "Family-owned Packaging Succession Targets" },
  { id: "s6", title: "Mid-market PE Funds Active in Fintech" },
  { id: "s7", title: "Iberian Renewable Energy Developers" },
  { id: "s8", title: "Strategic Acquirers for HR SaaS Platform" },
  { id: "s9", title: "Austrian Dental Lab Consolidation" },
  { id: "s10", title: "French Aerospace Tier-2 Supplier Longlist" },
  { id: "s11", title: "Swiss Wealth Management Boutiques" },
  { id: "s12", title: "Buy-side Comps: Industrial IoT 2026" },
  { id: "s13", title: "Founder-led Cybersecurity Firms DACH" },
  { id: "s14", title: "Polish Food Ingredients Add-on Targets" },
  { id: "s15", title: "Family Offices Investing in Healthcare" },
  { id: "s16", title: "Precedent Transactions: Testing & Inspection" },
  { id: "s17", title: "Scandinavian EdTech Exit Candidates" },
  { id: "s18", title: "Italian Luxury Leather Goods Suppliers" },
  { id: "s19", title: "Infrastructure Funds Seeking Fibre Assets" },
  { id: "s20", title: "Dutch Facility Services Buy-and-Build" },
  { id: "s21", title: "Management Contacts: Auto Parts Distributors" },
  { id: "s22", title: "Secondary Buyout Candidates Q1 2027" },
];

function sortRecents<T extends { pinned?: boolean }>(items: T[]) {
  return [...items].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned));
}

const itemClass =
  "flex h-8 w-full cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg px-2 text-left text-[14px] whitespace-nowrap text-ink transition-colors hover:bg-subtle";

const recentRowClass =
  "flex w-full items-center gap-2.5 overflow-hidden rounded-lg px-2 py-1.5 text-left text-[14px] whitespace-nowrap text-gray-500 transition-colors hover:bg-subtle hover:text-gray-900";

const recentTitleClass = "min-w-0 flex-1 truncate";

const SLIDE = { duration: 0.4, ease: [0.32, 0.72, 0, 1] } as const;

const SETTINGS_NAV: { label: MessageKey; icon: typeof Home; href: string }[] = [
  { label: "Profile", icon: User, href: "/settings/profile" },
  { label: "Members", icon: Users, href: "/settings/members" },
];

/** Claude-like width on Home / chat; narrower when the list table is open. */
const EXPANDED = 272;
const COMPACT = 208; // ~w-52 — more room for the 3-column list view
const COLLAPSED = 52;
/** How many Recents show before "View all". */
const RECENTS_PREVIEW = 6;

export const Sidebar = memo(function Sidebar({ user }: { user: string }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const conversations = useChatList();
  const { renameConversation, deleteConversation, togglePinConversation } =
    useChatActions();
  const [samples, setSamples] = useState(SAMPLE_RECENTS_SEED);
  const [recentsOpen, setRecentsOpen] = useState(true);
  const [showAllRecents, setShowAllRecents] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const inSettings = pathname.startsWith("/settings");
  // Sections that only make sense with labels fade out in the collapsed rail.
  const fade = `transition-opacity duration-200 ${collapsed ? "pointer-events-none opacity-0" : "opacity-100 delay-100"}`;

  // One list so pinned chats (live or sample) always sit above unpinned ones.
  const recents = useMemo(
    () =>
      sortRecents([
        ...conversations.map((c) => ({ kind: "live" as const, ...c })),
        ...samples.map((s) => ({ kind: "sample" as const, ...s })),
      ]),
    [conversations, samples],
  );

  const visibleRecents = useMemo(() => {
    if (showAllRecents || recents.length <= RECENTS_PREVIEW) return recents;
    const preview = recents.slice(0, RECENTS_PREVIEW);
    // Keep the open chat visible even if it falls past the preview window.
    const active = recents.find(
      (r) => r.kind === "live" && pathname === `/c/${r.id}`,
    );
    if (active && !preview.some((r) => r.id === active.id)) {
      return [...preview.slice(0, RECENTS_PREVIEW - 1), active];
    }
    return preview;
  }, [recents, showAllRecents, pathname]);

  // Narrow the rail when the open chat is showing the buyer list / table.
  const listOpen = conversations.some(
    (c) => c.hasList && pathname === `/c/${c.id}`,
  );
  const openWidth = listOpen ? COMPACT : EXPANDED;
  const railWidth = collapsed ? COLLAPSED : openWidth;

  return (
    <aside
      style={{ width: railWidth }}
      className="h-full shrink-0 overflow-hidden bg-canvas font-sans transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
    >
      {/* Content width matches the open rail; clipped when collapsed. */}
      <div className="flex h-full flex-col" style={{ width: openWidth }}>
        <div className="flex h-[50px] items-center justify-between px-3">
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
                  style={{ width: railWidth }}
                  className="px-3 pt-1.5 transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
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
                  <button
                    type="button"
                    aria-expanded={recentsOpen}
                    aria-controls="recents-list"
                    onClick={() => setRecentsOpen((o) => !o)}
                    className="mt-6 mb-2 flex items-center gap-1 px-3 font-sans text-xs font-medium text-gray-400"
                  >
                    Recent work
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      viewBox="0 0 20 20"
                      fill="currentColor"
                      aria-hidden
                      className={`h-3.5 w-3.5 shrink-0 text-gray-400 transition-transform duration-200 ${recentsOpen ? "" : "-rotate-90"}`}
                    >
                      <path
                        fillRule="evenodd"
                        d="M5.23 7.21a.75.75 0 011.06.02L10 11.168l3.71-3.938a.75.75 0 111.08 1.04l-4.25 4.5a.75.75 0 01-1.08 0l-4.25-4.5a.75.75 0 01.02-1.06z"
                        clipRule="evenodd"
                      />
                    </svg>
                  </button>
                  {recentsOpen && (
                    <div className="mt-0.5 flex min-h-0 flex-1 flex-col">
                      <ul
                        id="recents-list"
                        className={`max-h-[calc(100vh-280px)] overflow-y-auto px-3 [scrollbar-width:none] ${
                          showAllRecents ? "pb-1" : ""
                        }`}
                      >
                        {visibleRecents.map((r) => {
                          if (r.kind === "live") {
                            const href = `/c/${r.id}`;
                            return (
                              <RecentRow
                                key={r.id}
                                title={r.title}
                                pinned={!!r.pinned}
                                busy={!!r.busy}
                                href={href}
                                active={pathname === href}
                                onRename={(title) =>
                                  renameConversation(r.id, title)
                                }
                                onDelete={() => {
                                  deleteConversation(r.id);
                                  if (pathname === href) router.push("/");
                                }}
                                onTogglePin={() =>
                                  togglePinConversation(r.id)
                                }
                              />
                            );
                          }
                          return (
                            <RecentRow
                              key={r.id}
                              title={r.title}
                              pinned={!!r.pinned}
                              onRename={(title) =>
                                setSamples((prev) =>
                                  prev.map((s) =>
                                    s.id === r.id ? { ...s, title } : s,
                                  ),
                                )
                              }
                              onDelete={() =>
                                setSamples((prev) =>
                                  prev.filter((s) => s.id !== r.id),
                                )
                              }
                              onTogglePin={() =>
                                setSamples((prev) =>
                                  prev.map((s) =>
                                    s.id === r.id
                                      ? { ...s, pinned: !s.pinned }
                                      : s,
                                  ),
                                )
                              }
                            />
                          );
                        })}
                      </ul>
                      {recents.length > RECENTS_PREVIEW && (
                        <button
                          type="button"
                          onClick={() => setShowAllRecents((v) => !v)}
                          className="mx-3 mt-2 mb-3 block shrink-0 px-2 text-left text-xs font-medium text-gray-400 transition-colors hover:text-gray-700"
                        >
                          {showAllRecents ? "Show less" : "View all"}
                        </button>
                      )}
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <div className="mt-auto shrink-0 border-t border-gray-200 px-3 py-3">
          <UserMenu user={user} collapsed={collapsed} fade={fade} />
        </div>
      </div>
    </aside>
  );
});

/** One Recents row: open chat, or ⋮ → pin / rename / delete. */
function RecentRow({
  title,
  pinned,
  busy,
  href,
  active,
  onRename,
  onDelete,
  onTogglePin,
}: {
  title: string;
  pinned: boolean;
  busy?: boolean;
  href?: string;
  active?: boolean;
  onRename: (title: string) => void;
  onDelete: () => void;
  onTogglePin: () => void;
}) {
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(title);
  const rowRef = useRef<HTMLLIElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(rowRef, menu !== null, closeMenu);

  function openMenu(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (menu) return closeMenu();
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ top: rect.bottom + 4, left: rect.right - 168 });
  }

  function startRename() {
    closeMenu();
    setDraft(title);
    setRenaming(true);
    requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
  }

  function commitRename() {
    const next = draft.trim();
    setRenaming(false);
    if (next && next !== title) onRename(next);
    else setDraft(title);
  }

  const menuItem =
    "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] transition-colors hover:bg-subtle";

  return (
    <li ref={rowRef} className="group relative">
      {renaming ? (
        <div className={`${recentRowClass} bg-[#ececee] text-ink ring-1 ring-sky`}>
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                commitRename();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setDraft(title);
                setRenaming(false);
              }
            }}
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none"
            aria-label="Rename chat"
          />
        </div>
      ) : href ? (
        <Link
          href={href}
          className={`${recentRowClass} pr-7 ${
            active ? "bg-[#ececee] text-gray-900 hover:bg-[#ececee]" : ""
          }`}
        >
          {pinned && (
            <PinIcon size={12} strokeWidth={2} filled className="shrink-0 text-muted" />
          )}
          <span className={recentTitleClass}>{title}</span>
        </Link>
      ) : (
        <button type="button" className={`${recentRowClass} pr-7`}>
          {pinned && (
            <PinIcon size={12} strokeWidth={2} filled className="shrink-0 text-muted" />
          )}
          <span className={recentTitleClass}>{title}</span>
        </button>
      )}

      {/* Busy dot sits where the ⋮ is; hover swaps to the options button. */}
      {busy && !renaming && (
        <span
          aria-hidden
          className={`pointer-events-none absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center transition-opacity ${menu ? "opacity-0" : "opacity-100 group-hover:opacity-0"}`}
        >
          <motion.span
            className="size-1.5 rounded-full bg-brand"
            animate={{ opacity: [1, 0.15, 1] }}
            transition={{
              duration: 0.9,
              repeat: Infinity,
              ease: "easeInOut",
            }}
          />
        </span>
      )}

      {!renaming && (
        <button
          type="button"
          aria-label="Chat actions"
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={openMenu}
          className={`absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-[#5d5d63] transition-opacity hover:bg-subtle ${menu || (!busy && active) ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        >
          <MoreVertical size={14} strokeWidth={1.75} />
        </button>
      )}

      <AnimatePresence>
        {menu && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, scale: 0.96, y: -2 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            style={{ top: menu.top, left: Math.max(8, menu.left) }}
            className="fixed z-30 w-[168px] origin-top-right rounded-xl border border-line bg-white p-1 shadow-[0_4px_20px_rgba(0,0,0,0.08)]"
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu();
                onTogglePin();
              }}
              className={menuItem}
            >
              <PinIcon size={15} className="text-[#5d5d63]" />
              {pinned ? "Unpin" : "Pin"}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={startRename}
              className={menuItem}
            >
              <Edit2 size={15} strokeWidth={1.75} className="text-[#5d5d63]" />
              Rename
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu();
                onDelete();
              }}
              className={menuItem}
            >
              <Trash2 size={15} strokeWidth={1.75} className="text-[#5d5d63]" />
              Delete
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

// Back arrow (to home) beside the "Settings" title, then the settings pages.
// Icons sit where the app nav's icons do, so the rail looks the same.
function SettingsNav({ pathname, fade }: { pathname: string; fade: string }) {
  const { t } = useI18n();
  const router = useRouter();
  return (
    <nav className="px-3 pt-1.5">
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
          className={`truncate text-[16px] font-medium whitespace-nowrap ${fade}`}
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
        style={{ width: collapsed ? 30 : "100%" }}
        className={`flex cursor-pointer items-center gap-2.5 overflow-hidden rounded-lg px-1 py-1 text-left transition-[width,background-color] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-subtle ${anchor ? "bg-subtle" : ""}`}
      >
        <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sky text-[11px] font-medium text-[#41526b]">
          {user[0]?.toUpperCase()}
        </span>
        <span className={`min-w-0 flex-1 truncate text-[13px] leading-none ${fade}`}>
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
