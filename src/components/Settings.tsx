"use client";

import { AnimatePresence, motion } from "motion/react";
import Image from "next/image";
import { usePathname } from "next/navigation";
import { useCallback, useRef, useState } from "react";
import { Check, ChevronDown } from "react-feather";
import { useDismiss } from "@/lib/useDismiss";

const EASE = [0.32, 0.72, 0, 1] as const;

// The signed-in demo user; the name is hard-coded like the home greeting.
const ME = { name: "Vanya Brucker", email: "vanya.brucker@helbling.ch" };

type Member = {
  name: string;
  email: string;
  role: "Admin" | "Member";
  /** Portrait in public/portraits; initials otherwise. */
  photo?: string;
};

const person = (
  first: string,
  last: string,
  photo: string,
  role: Member["role"] = "Admin",
): Member => ({
  name: `${first} ${last}`,
  // firstname.lastname@helbling.ch, umlauts spelled out (ä → ae).
  email: `${first}.${last}@helbling.ch`
    .toLowerCase()
    .replace(/ä/g, "ae")
    .replace(/ö/g, "oe")
    .replace(/ü/g, "ue"),
  role,
  photo: `/portraits/${photo}.jpg`,
});

const MEMBERS: Member[] = [
  { ...ME, role: "Admin" },
  person("Eduard", "Dorzweiler", "eduard_dorzweiler"),
  person("Gabriel", "Schmidhäusler", "gabriel_schmidhaeusler", "Member"),
  person("Ivor", "Kramer", "ivor_kramer"),
  person("Malte", "Jantz", "malte_jantz"),
  person("Nicolas", "Gubler", "nicolas_gubler"),
  person("Nuria", "Pantaleo", "nuria_pantaleo", "Member"),
];

const inputClass =
  "h-9 rounded-lg border border-line bg-white px-3 text-[14px] outline-none transition-shadow placeholder:text-faint focus:border-[#c9d9ef] focus:ring-3 focus:ring-sky";

/** Settings content; the section comes from the URL like the workspace's mode. */
export function SettingsPanel() {
  const pathname = usePathname();
  const section = pathname.startsWith("/settings/members")
    ? "members"
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
            {section === "members" ? <Members /> : <Profile />}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function Title({ children }: { children: string }) {
  return (
    <div className="mb-7">
      <h1 className="font-serif text-[28px] leading-tight tracking-[-0.01em]">
        {children}
      </h1>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex min-h-[60px] items-center justify-between gap-6 py-3">
      <span className="text-[14px] font-medium">{label}</span>
      {children}
    </div>
  );
}

function Profile() {
  const [name, setName] = useState(ME.name);
  const [language, setLanguage] = useState("English");

  return (
    <>
      <Title>Profile</Title>
      <div className="divide-y divide-line rounded-xl border border-line px-5">
        <Row label="Profile picture">
          <Avatar name={ME.name} size={36} />
        </Row>
        <Row label="Email">
          <span className="text-[14px]">{ME.email}</span>
        </Row>
        <Row label="Full name">
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Full name"
            className={`${inputClass} w-[240px]`}
          />
        </Row>
        <Row label="Language">
          <Select
            value={language}
            options={["English", "German"]}
            onChange={setLanguage}
            label="Language"
            width={240}
          />
        </Row>
      </div>
    </>
  );
}

// Invite row and member rows share the columns, so the role pills line up
// under the role dropdown.
const MEMBER_GRID = "grid grid-cols-[1fr_120px_76px] items-center gap-3";

function Members() {
  const [role, setRole] = useState("Member");

  return (
    <>
      <Title>Members</Title>
      <div className="rounded-xl border border-line">
        {/* Inert like the rest of the non-demo controls. */}
        <form
          onSubmit={(e) => e.preventDefault()}
          className={`${MEMBER_GRID} p-4`}
        >
          <input
            type="email"
            placeholder="name@helbling.ch"
            aria-label="Email to invite"
            className={inputClass}
          />
          <Select
            value={role}
            options={["Member", "Admin"]}
            onChange={setRole}
            label="Role"
          />
          <button
            type="submit"
            className="h-9 rounded-lg bg-ink text-[14px] font-medium text-white transition-colors hover:bg-[#26262a]"
          >
            Invite
          </button>
        </form>

        <ul>
          {MEMBERS.map((m) => (
            <li
              key={m.email}
              className={`${MEMBER_GRID} border-t border-line px-4 py-3`}
            >
              <div className="flex min-w-0 items-center gap-3">
                <Avatar name={m.name} photo={m.photo} size={32} />
                <div className="min-w-0">
                  <div className="truncate text-[14px] font-medium">
                    {m.name}
                  </div>
                  <div className="truncate text-[13px] text-muted">
                    {m.email}
                  </div>
                </div>
              </div>
              <span
                className={`justify-self-start rounded-md px-2 py-0.5 text-[12.5px] font-medium ${m.role === "Admin" ? "bg-sky text-sky-ink" : "bg-subtle text-muted"}`}
              >
                {m.role}
              </span>
            </li>
          ))}
        </ul>
      </div>
    </>
  );
}

function Avatar({
  name,
  photo,
  size,
}: {
  name: string;
  photo?: string;
  size: number;
}) {
  if (photo)
    return (
      <Image
        src={photo}
        alt=""
        width={size}
        height={size}
        className="shrink-0 rounded-full bg-subtle object-cover"
        style={{ width: size, height: size }}
      />
    );
  return (
    <span
      style={{ width: size, height: size, fontSize: size * 0.4 }}
      className="flex shrink-0 items-center justify-center rounded-full bg-sky font-medium text-[#41526b]"
    >
      {name[0]}
    </span>
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
