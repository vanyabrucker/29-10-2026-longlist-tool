"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { memo, useCallback, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowLeft,
  Briefcase,
  ChevronDown,
  Edit2,
  Home,
  LogOut,
  MoreVertical,
  Settings,
  Sidebar as SidebarIcon,
  Table,
  Trash2,
  UploadCloud,
  User,
  Users,
} from "react-feather";
import { signOut, type User as Account } from "@/lib/auth";
import { useChatActions, useChatList } from "@/lib/chat";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { useDismiss } from "@/lib/useDismiss";
import { Logo } from "./Logo";
import { Modal, modalPrimary, modalSecondary } from "./Modal";
import { PinIcon } from "./PinIcon";

const NAV: {
  label: MessageKey;
  icon: typeof Home;
  href?: string;
  devOnly?: boolean;
}[] = [
  { label: "Home", icon: Home, href: "/" },
  { label: "Companies", icon: Briefcase, href: "/companies" },
  { label: "Longlists", icon: Table, href: "/longlists" },
  // Spreadsheet imports into the master database (helios-gateway).
  {
    label: "Imports",
    icon: UploadCloud,
    href: "/admin/imports",
    devOnly: true,
  },
];

const itemClass =
  "flex h-8 w-full items-center gap-2.5 overflow-hidden rounded-lg px-2 text-left text-[14px] whitespace-nowrap text-ink transition-colors hover:bg-subtle";

// Recents: grey until hovered; the open chat is ink on its grey pill. The
// hover is on the row (group), so it stays while the ⋮ button is hovered.
const recentClass = (active: boolean) =>
  `flex h-8 w-full items-center overflow-hidden rounded-lg px-2 text-left text-[14px] whitespace-nowrap transition-colors ${
    active
      ? "bg-[#ececee] text-ink"
      : "text-muted group-hover:bg-subtle group-hover:text-ink"
  }`;

const SLIDE = { duration: 0.4, ease: [0.32, 0.72, 0, 1] } as const;

const SETTINGS_NAV: { label: MessageKey; icon: typeof Home; href: string }[] = [
  { label: "Profile", icon: User, href: "/settings/profile" },
  { label: "Members", icon: Users, href: "/settings/members" },
];

// Roomy on home and in chat; narrower while a chat's buyer table is open,
// so the table gets the space.
const EXPANDED = 272;
const COMPACT = 208;
const COLLAPSED = 52;

export const Sidebar = memo(function Sidebar({ user }: { user: Account }) {
  const { t } = useI18n();
  const pathname = usePathname();
  const router = useRouter();
  const conversations = useChatList();
  const { renameConversation, deleteConversation, togglePinConversation } =
    useChatActions();
  const [collapsed, setCollapsed] = useState(false);
  const [recentsOpen, setRecentsOpen] = useState(true);
  const [pendingDelete, setPendingDelete] = useState<{
    id: string;
    title: string;
    href: string;
  } | null>(null);
  const recents = useMemo(
    () =>
      [...conversations].sort(
        (a, b) => Number(!!b.pinned) - Number(!!a.pinned),
      ),
    [conversations],
  );
  const listOpen = conversations.some(
    (c) => c.hasList && pathname === `/c/${c.id}`,
  );
  const openWidth = listOpen ? COMPACT : EXPANDED;
  const railWidth = collapsed ? COLLAPSED : openWidth;
  const inSettings = pathname.startsWith("/settings");
  // Sections that only make sense with labels fade out in the collapsed rail.
  const fade = `transition-opacity duration-200 ${collapsed ? "pointer-events-none opacity-0" : "opacity-100 delay-100"}`;

  return (
    <aside
      style={{ width: railWidth }}
      className="h-full shrink-0 overflow-hidden bg-canvas transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
    >
      {/* Content keeps the open width and is clipped, so labels don't reflow
          while collapsing. */}
      <div className="flex h-full flex-col" style={{ width: openWidth }}>
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
                  style={{ width: railWidth }}
                  className="px-[11px] pt-1.5 transition-[width] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)]"
                >
                  {NAV.filter((n) => !n.devOnly || user.is_dev).map(
                    ({ label, icon: Icon, href }) => {
                      const active =
                        href === pathname ||
                        (href === "/admin/imports" &&
                          pathname.startsWith("/admin"));
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
                    },
                  )}
                </nav>

                <div className={`flex min-h-0 flex-1 flex-col ${fade}`}>
                  {/* Collapsible, like a disclosure: the chevron turns to
                      point right while the list is hidden. */}
                  <button
                    type="button"
                    aria-expanded={recentsOpen}
                    aria-controls="recents"
                    onClick={() => setRecentsOpen((o) => !o)}
                    className="mt-5 flex w-max items-center gap-1 pl-[17px] text-[12.5px] text-muted transition-colors hover:text-ink"
                  >
                    {t("Recents")}
                    <ChevronDown
                      size={12}
                      strokeWidth={2}
                      className={`transition-transform duration-200 ${recentsOpen ? "" : "-rotate-90"}`}
                    />
                  </button>
                  <AnimatePresence initial={false}>
                    {recentsOpen && (
                      <motion.ul
                        id="recents"
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.2, ease: [0.32, 0.72, 0, 1] }}
                        className="mt-1.5 min-h-0 flex-1 space-y-px overflow-y-auto px-[11px] pb-2 [scrollbar-width:none]"
                      >
                        {recents.map((r) => {
                          const href = `/c/${r.id}`;
                          return (
                            <RecentRow
                              key={r.id}
                              title={r.title || "…"}
                              pinned={!!r.pinned}
                              busy={r.busy}
                              href={href}
                              active={pathname === href}
                              onTogglePin={() => togglePinConversation(r.id)}
                              onRename={(title) =>
                                renameConversation(r.id, title)
                              }
                              onDelete={() =>
                                setPendingDelete({
                                  id: r.id,
                                  title: r.title || "…",
                                  href,
                                })
                              }
                            />
                          );
                        })}
                      </motion.ul>
                    )}
                  </AnimatePresence>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <Modal
          open={!!pendingDelete}
          onClose={() => setPendingDelete(null)}
          labelledBy="delete-chat-title"
        >
          <h3 id="delete-chat-title" className="text-[16px] font-medium">
            {t("Delete chat?")}
          </h3>
          <p className="mt-2 text-[14px] leading-relaxed text-muted">
            {t("Delete “{title}”? This cannot be undone.", {
              title: pendingDelete?.title ?? "",
            })}
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setPendingDelete(null)}
              className={modalSecondary}
            >
              {t("Cancel")}
            </button>
            <button
              type="button"
              onClick={() => {
                if (!pendingDelete) return;
                if (pathname === pendingDelete.href) router.push("/");
                deleteConversation(pendingDelete.id);
                setPendingDelete(null);
              }}
              className={modalPrimary}
            >
              {t("Delete")}
            </button>
          </div>
        </Modal>

        {/* Extra room above the user menu, and a fade so recent chats
            disappear behind it instead of ending at a hard edge. */}
        <div className="relative flex h-14 shrink-0 items-center px-[11px] pt-2">
          <div
            aria-hidden
            className="pointer-events-none absolute inset-x-0 bottom-full h-10 bg-gradient-to-t from-canvas to-transparent"
          />
          <UserMenu
            user={user}
            collapsed={collapsed}
            fade={fade}
            width={openWidth - 22}
          />
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

const ROLE_LABEL: Record<Account["role"], MessageKey> = {
  member: "Member",
  admin: "Admin",
  dev: "Dev",
};

function UserMenu({
  user,
  collapsed,
  fade,
  width,
}: {
  user: Account;
  collapsed: boolean;
  fade: string;
  width: number;
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
        style={{ width: collapsed ? 30 : width }}
        className={`flex h-9 items-center gap-2 overflow-hidden rounded-lg px-[5px] text-left transition-[width,background-color] duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:bg-subtle ${anchor ? "bg-subtle" : ""}`}
      >
        <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-sky text-[10px] font-medium text-[#41526b]">
          {user.name[0]?.toUpperCase()}
        </span>
        <span
          className={`flex min-w-0 flex-1 items-center gap-1.5 text-[13px] ${fade}`}
        >
          <span className="truncate">{user.name}</span>
          <span
            aria-hidden
            className="size-[3px] shrink-0 rounded-full bg-faint"
          />
          <span className="shrink-0 text-muted">
            {t(ROLE_LABEL[user.role])}
          </span>
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
              onClick={async () => {
                close();
                await signOut();
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

/**
 * One Recents row: the chat link (or an inert sample), a ⋮ menu on hover
 * with Pin / Rename / Delete, and a pulsing dot while the chat generates.
 * Pinned rows show a filled pushpin.
 */
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
  busy: boolean;
  href?: string;
  active: boolean;
  onRename: (title: string) => void;
  onDelete: () => void;
  onTogglePin: () => void;
}) {
  const { t } = useI18n();
  const [menu, setMenu] = useState<{ top: number; left: number } | null>(null);
  const [renaming, setRenaming] = useState(false);
  const rowRef = useRef<HTMLLIElement>(null);
  const closeMenu = useCallback(() => setMenu(null), []);
  useDismiss(rowRef, menu !== null, closeMenu);

  function openMenu(e: React.MouseEvent<HTMLButtonElement>) {
    e.preventDefault();
    e.stopPropagation();
    if (menu) return closeMenu();
    // Fixed position so the menu isn't clipped by the scrolling list.
    const rect = e.currentTarget.getBoundingClientRect();
    setMenu({ top: rect.bottom + 4, left: rect.right - MENU_WIDTH });
  }

  function finishRename(next: string | null) {
    setRenaming(false);
    if (next !== null && next.trim() && next.trim() !== title)
      onRename(next.trim());
  }

  const menuItem =
    "flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[14px] transition-colors hover:bg-subtle";
  const label = (
    <>
      {pinned && (
        <PinIcon
          size={12}
          strokeWidth={2}
          filled
          className="shrink-0 text-muted"
        />
      )}
      <span className="min-w-0 flex-1 truncate">{title}</span>
    </>
  );

  return (
    <li ref={rowRef} className="group relative">
      {renaming ? (
        <input
          autoFocus
          defaultValue={title}
          aria-label={t("Rename chat")}
          onFocus={(e) => e.currentTarget.select()}
          onBlur={(e) => finishRename(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") finishRename(e.currentTarget.value);
            else if (e.key === "Escape") finishRename(null);
          }}
          className="flex h-8 w-full rounded-lg bg-white px-2 text-[14px] text-ink ring-1 ring-sky-ink outline-none"
        />
      ) : href ? (
        <Link href={href} className={`${recentClass(active)} gap-1.5 pr-8`}>
          {label}
        </Link>
      ) : (
        <button type="button" className={`${recentClass(false)} gap-1.5 pr-8`}>
          {label}
        </button>
      )}

      {/* The busy dot sits where the ⋮ appears; hovering swaps them. */}
      {busy && !renaming && (
        <span
          aria-hidden
          className={`pointer-events-none absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center transition-opacity ${menu ? "opacity-0" : "group-hover:opacity-0"}`}
        >
          <motion.span
            className="size-1.5 rounded-full bg-brand"
            animate={{ opacity: [1, 0.15, 1] }}
            transition={{ duration: 0.9, repeat: Infinity, ease: "easeInOut" }}
          />
        </span>
      )}
      {!renaming && (
        <button
          type="button"
          aria-label={t("Chat actions")}
          aria-haspopup="menu"
          aria-expanded={menu !== null}
          onClick={openMenu}
          className={`absolute top-1/2 right-1 flex size-6 -translate-y-1/2 items-center justify-center rounded-md text-[#5d5d63] transition-opacity hover:text-ink ${menu ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"}`}
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
            style={{
              top: menu.top,
              left: Math.max(8, menu.left),
              width: MENU_WIDTH,
            }}
            className="fixed z-30 origin-top-right rounded-xl border border-line bg-white p-1 shadow-[0_4px_20px_rgba(0,0,0,0.08)]"
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
              <PinIcon className="text-[#5d5d63]" />
              {t(pinned ? "Unpin" : "Pin")}
            </button>
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                closeMenu();
                setRenaming(true);
              }}
              className={menuItem}
            >
              <Edit2 size={15} strokeWidth={1.75} className="text-[#5d5d63]" />
              {t("Rename")}
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
              {t("Delete")}
            </button>
          </motion.div>
        )}
      </AnimatePresence>
    </li>
  );
}

const MENU_WIDTH = 168;
