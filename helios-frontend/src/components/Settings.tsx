"use client";

import { AnimatePresence, motion } from "motion/react";
import { usePathname } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Copy, Loader, Trash2 } from "@/components/icons";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { updateProfile, useUser, type User } from "@/lib/auth";
import { GatewayError, gw, json } from "@/lib/gateway";
import { MEMBERS } from "@/lib/members";
import { useDismiss } from "@/lib/useDismiss";
import { Avatar } from "./Avatar";
import { Impressum } from "./Impressum";
import { Modal, modalPrimary, modalSecondary } from "./Modal";

const EASE = [0.32, 0.72, 0, 1] as const;

const inputClass =
  "h-9 rounded-lg border border-line bg-white px-3 text-[14px] outline-none transition-shadow placeholder:text-faint focus:border-[#c9d9ef] focus:ring-3 focus:ring-sky";

/** Settings content; the section comes from the URL like the workspace's mode. */
export function SettingsPanel() {
  const pathname = usePathname();
  const section = pathname.startsWith("/settings/members")
    ? "members"
    : pathname.startsWith("/settings/impressum")
      ? "impressum"
      : "profile";

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-tl-xl border-t border-l border-line bg-white">
      <div className="min-h-0 flex-1 overflow-y-auto">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={section}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, transition: { duration: 0.1 } }}
            transition={{ duration: 0.3, ease: EASE }}
            className="mx-auto w-full max-w-[640px] px-6 pt-16 pb-16"
          >
            {section === "members" ? (
              <Members />
            ) : section === "impressum" ? (
              <Impressum />
            ) : (
              <Profile />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function Title({ text }: { text: MessageKey }) {
  const { t } = useI18n();
  return (
    <div className="mb-7">
      <h1 className="font-serif text-[28px] leading-tight tracking-[-0.01em]">
        {t(text)}
      </h1>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: MessageKey;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[60px] items-center justify-between gap-6 py-3">
      <span className="text-[14px] font-medium">{t(label)}</span>
      {children}
    </div>
  );
}

function Profile() {
  const user = useUser();
  // AppShell renders settings only once the user is known.
  return user ? <ProfileCard key={user.id} user={user} /> : null;
}

function ProfileCard({ user }: { user: User }) {
  const { t, lang } = useI18n();
  const [name, setName] = useState(user.name);
  const [failed, setFailed] = useState(false);
  const photo = MEMBERS.find((m) => m.email === user.email)?.photo;

  async function save(patch: Parameters<typeof updateProfile>[0]) {
    setFailed(false);
    try {
      const saved = await updateProfile(patch);
      setName(saved.name);
    } catch {
      setFailed(true);
    }
  }

  // Saved on Enter or when the field loses focus; an empty name reverts.
  function commitName() {
    const next = name.trim();
    if (!next) return setName(user.name);
    if (next !== user.name) save({ name: next });
  }

  return (
    <>
      <Title text="Profile" />
      <div className="divide-y divide-line rounded-xl border border-line px-5">
        <Row label="Profile picture">
          <Avatar name={user.name} photo={photo} size={36} />
        </Row>
        <Row label="Email">
          <span className="text-[14px]">{user.email}</span>
        </Row>
        <Row label="Full name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitName}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") {
                setName(user.name);
                // Blur after the reset lands, so it doesn't save the edit.
                requestAnimationFrame(() => e.currentTarget?.blur());
              }
            }}
            aria-label={t("Full name")}
            className={`${inputClass} w-[240px]`}
          />
        </Row>
        <Row label="Language">
          {/* Each language is named in itself. */}
          <Select
            value={LANGUAGES[lang]}
            options={Object.values(LANGUAGES)}
            onChange={(choice) =>
              save({ language: choice === LANGUAGES.de ? "de" : "en" })
            }
            label={t("Language")}
            width={240}
          />
        </Row>
      </div>
      {failed && (
        <p role="alert" className="mt-3 text-[13px] text-bad">
          {t("Couldn't save. Try again.")}
        </p>
      )}
    </>
  );
}

// Add row and member rows share the columns, so the role pills line up
// under the role dropdown and the remove buttons under the Add button.
const MEMBER_GRID = "grid grid-cols-[1fr_120px_76px] items-center gap-3";

const LANGUAGES = { en: "English", de: "Deutsch" } as const;

const ROLE_LABEL: Record<User["role"], MessageKey> = {
  member: "Member",
  admin: "Admin",
  dev: "Dev",
};
// Who may remove whom: nobody removes someone with a higher role.
const RANK: Record<User["role"], number> = { member: 0, admin: 1, dev: 2 };

/** A portrait from public/portraits when the team list has one. */
const photoFor = (email: string) =>
  MEMBERS.find((m) => m.email === email)?.photo;

function Members() {
  const { t } = useI18n();
  const me = useUser();
  const [users, setUsers] = useState<User[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [removing, setRemoving] = useState<User | null>(null);
  const [issued, setIssued] = useState<{
    email: string;
    password: string;
  } | null>(null);

  useEffect(() => {
    gw<User[]>("/users").then(setUsers, () => setLoadFailed(true));
  }, []);

  if (!me) return null;
  const canManage = me.is_admin;

  return (
    <>
      <Title text="Members" />
      <div className="rounded-xl border border-line">
        {canManage && (
          <AddMember
            onAdded={(user, password) => {
              setUsers((list) =>
                [...(list ?? []), user].sort((a, b) =>
                  a.name.localeCompare(b.name),
                ),
              );
              setIssued({ email: user.email, password });
            }}
          />
        )}

        {loadFailed ? (
          <p className="border-t border-line px-4 py-6 text-[14px] text-muted first:border-t-0">
            {t("The server isn't reachable. Try again in a moment.")}
          </p>
        ) : (
          <ul>
            {(users ?? []).map((u) => {
              const removable =
                canManage && u.id !== me.id && RANK[u.role] <= RANK[me.role];
              return (
                <li
                  key={u.id}
                  className={`group ${MEMBER_GRID} border-t border-line px-4 py-3 first:border-t-0`}
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <Avatar name={u.name} photo={photoFor(u.email)} size={32} />
                    <div className="min-w-0">
                      <div className="truncate text-[14px] font-medium">
                        {u.name}
                        {u.id === me.id && (
                          <span className="font-normal text-muted">
                            {" "}
                            {t("(you)")}
                          </span>
                        )}
                      </div>
                      <div className="truncate text-[13px] text-muted">
                        {u.email}
                      </div>
                    </div>
                  </div>
                  <span
                    className={`justify-self-start rounded-md px-2 py-0.5 text-[12.5px] font-medium ${u.role === "member" ? "bg-subtle text-muted" : "bg-sky text-sky-ink"}`}
                  >
                    {t(ROLE_LABEL[u.role])}
                  </span>
                  {removable && (
                    <button
                      type="button"
                      onClick={() => setRemoving(u)}
                      aria-label={t("Remove {name}", { name: u.name })}
                      className="flex size-8 items-center justify-center justify-self-end rounded-full text-muted opacity-0 transition-[opacity,background-color,color] group-hover:opacity-100 hover:bg-subtle hover:text-ink focus-visible:opacity-100"
                    >
                      <Trash2 size={15} strokeWidth={1.75} />
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <RemoveDialog
        user={removing}
        onClose={() => setRemoving(null)}
        onRemoved={(id) =>
          setUsers((list) => list?.filter((u) => u.id !== id) ?? list)
        }
      />
      <PasswordDialog issued={issued} onClose={() => setIssued(null)} />
    </>
  );
}

function AddMember({
  onAdded,
}: {
  onAdded: (user: User, password: string) => void;
}) {
  const { t } = useI18n();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"member" | "admin">("member");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !email.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const created = await gw<{ user: User; password: string }>("/users", {
        method: "POST",
        ...json({ email: email.trim(), role }),
      });
      setEmail("");
      setRole("member");
      onAdded(created.user, created.password);
    } catch (err) {
      const status = err instanceof GatewayError ? err.status : 0;
      setError(
        status === 409
          ? "A user with this email exists already."
          : status === 422
            ? "Enter a valid email address."
            : "Couldn't save. Try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="border-b border-line p-4">
      <div className={MEMBER_GRID}>
        <input
          type="email"
          required
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="name@helbling.ch"
          aria-label={t("Email of the new member")}
          className={inputClass}
        />
        <Select
          value={t(ROLE_LABEL[role])}
          options={[t("Member"), t("Admin")]}
          onChange={(r) => setRole(r === t("Admin") ? "admin" : "member")}
          label={t("Role")}
        />
        <button
          type="submit"
          disabled={busy}
          className="flex h-9 items-center justify-center rounded-full bg-ink text-[14px] font-medium text-white transition-colors hover:bg-[#26262a] disabled:opacity-60"
        >
          {busy ? (
            <Loader size={15} strokeWidth={2} className="animate-spin" />
          ) : (
            t("Add")
          )}
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-[13px] text-bad">
          {t(error)}
        </p>
      )}
    </form>
  );
}

function RemoveDialog({
  user,
  onClose,
  onRemoved,
}: {
  user: User | null;
  onClose: () => void;
  onRemoved: (id: string) => void;
}) {
  const { t } = useI18n();
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  // Keeps the name on screen while the dialog fades out.
  const [shown, setShown] = useState(user);
  if (user && user !== shown) setShown(user);

  async function remove() {
    if (!user) return;
    setBusy(true);
    setFailed(false);
    try {
      await gw(`/users/${user.id}`, { method: "DELETE" });
      onRemoved(user.id);
      onClose();
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={!!user}
      onClose={busy ? undefined : onClose}
      labelledBy="remove-title"
    >
      <h3 id="remove-title" className="text-[16px] font-medium">
        {t("Remove {name}?", { name: shown?.name ?? "" })}
      </h3>
      <p className="mt-2 text-[14px] leading-relaxed text-muted">
        {t("They can no longer sign in. Data they imported or edited stays.")}
      </p>
      {failed && (
        <p role="alert" className="mt-2 text-[13px] text-bad">
          {t("Couldn't save. Try again.")}
        </p>
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          disabled={busy}
          className={modalSecondary}
        >
          {t("Cancel")}
        </button>
        <button
          type="button"
          onClick={remove}
          disabled={busy}
          className={modalPrimary}
        >
          {t("Remove")}
        </button>
      </div>
    </Modal>
  );
}

/**
 * The generated password, shown once. Only "Done" closes it (no Escape or
 * backdrop click), so it can't be dismissed by accident before it's copied.
 */
function PasswordDialog({
  issued,
  onClose,
}: {
  issued: { email: string; password: string } | null;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const [shown, setShown] = useState(issued);
  if (issued && issued !== shown) {
    setShown(issued);
    setCopied(false);
  }

  const codeRef = useRef<HTMLElement>(null);

  async function copy() {
    if (!shown) return;
    try {
      await navigator.clipboard.writeText(shown.password);
      return setCopied(true);
    } catch {}
    // Clipboard API refused (no permission, insecure context): select the
    // password and use the older copy command, which also leaves it selected
    // for a manual ⌘C if even that fails.
    const code = codeRef.current;
    if (!code) return;
    const range = document.createRange();
    range.selectNodeContents(code);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (document.execCommand("copy")) setCopied(true);
  }

  return (
    <Modal open={!!issued} labelledBy="password-title">
      <h3 id="password-title" className="text-[16px] font-medium">
        {t("{email} was added", { email: shown?.email ?? "" })}
      </h3>
      <p className="mt-2 text-[14px] leading-relaxed text-muted">
        {t("Share this password with them. It's shown only this once.")}
      </p>
      <div className="mt-4 flex h-10 items-center gap-2 rounded-lg border border-line bg-subtle pr-1 pl-3">
        <code
          ref={codeRef}
          className="min-w-0 flex-1 truncate font-mono text-[14px] tracking-wide select-all"
        >
          {shown?.password}
        </code>
        <button
          type="button"
          onClick={copy}
          className="flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors hover:bg-white"
        >
          {copied ? (
            <Check size={14} strokeWidth={2} />
          ) : (
            <Copy size={14} strokeWidth={1.75} />
          )}
          {copied ? t("Copied") : t("Copy")}
        </button>
      </div>
      <div className="mt-5 flex justify-end">
        <button type="button" onClick={onClose} className={modalPrimary}>
          {t("Done")}
        </button>
      </div>
    </Modal>
  );
}

function Select({
  value,
  options,
  onChange,
  label,
  width,
}: {
  value: string;
  options: string[];
  onChange: (value: string) => void;
  label: string;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  return (
    <div ref={ref} className="relative" style={{ width }}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${value}`}
        onClick={() => setOpen((o) => !o)}
        className={`flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-line bg-white pr-2 pl-3 text-[14px] transition-colors hover:bg-subtle ${open ? "bg-subtle" : ""}`}
      >
        {value}
        <ChevronDown
          size={14}
          strokeWidth={1.75}
          className={`text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            role="listbox"
            aria-label={label}
            initial={{ opacity: 0, scale: 0.96, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.1 } }}
            transition={{ duration: 0.15, ease: "easeOut" }}
            className="absolute top-full right-0 z-20 mt-1.5 w-full min-w-[160px] origin-top-right rounded-xl border border-line bg-white p-1 shadow-[0_4px_20px_rgba(0,0,0,0.08)]"
          >
            {options.map((o) => (
              <button
                key={o}
                type="button"
                role="option"
                aria-selected={o === value}
                onClick={() => {
                  onChange(o);
                  close();
                }}
                className="flex h-9 w-full items-center justify-between rounded-lg px-2.5 text-left text-[14px] transition-colors hover:bg-subtle"
              >
                {o}
                {o === value && <Check size={15} strokeWidth={2} />}
              </button>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
