"use client";

import { motion } from "motion/react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { ArrowLeft, ChevronRight } from "@/components/icons";
import {
  contactRoleLine,
  knownPhoto,
  type ContactDetail,
  type ContactRole,
} from "@/lib/contacts";
import type { Cell } from "@/lib/corpus";
import { gw } from "@/lib/gateway";
import { useI18n } from "@/lib/i18n";
import { Avatar } from "./Avatar";
import { DataPointRow } from "./CompanyDetail";

const EASE = [0.32, 0.72, 0, 1] as const;
const keyOf = (c: Cell) => `${c.field}:${c.period ?? 0}`;

/** One contact: every data point with its sources (no priorities: those are
 * for companies), the companies they work or worked at, and who knows them. */
export function ContactDetailPanel({ id }: { id: string }) {
  const { t } = useI18n();
  const router = useRouter();
  const [contact, setContact] = useState<ContactDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());

  useEffect(() => {
    let live = true;
    gw<ContactDetail>(`/contacts/${encodeURIComponent(id)}`).then(
      (c) => live && setContact(c),
      () => live && setMissing(true),
    );
    return () => {
      live = false;
    };
  }, [id]);

  const back = () =>
    // Back to the search as it was, or to the search page on a direct visit.
    window.history.length > 1 ? router.back() : router.push("/contacts");

  const toggle = (key: string) =>
    setOpen((s) => {
      const next = new Set(s);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  const current = contact?.roles.find((r) => r.current);
  const subline = current ? contactRoleLine(current) : "";

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="min-h-0 flex-1 overflow-y-auto px-8 pt-8 pb-12 [scrollbar-width:none]"
    >
      <div className="mx-auto max-w-[880px]">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={back}
            aria-label={t("Back to contacts")}
            className="-ml-1.5 flex size-8 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-subtle hover:text-ink"
          >
            <ArrowLeft size={17} strokeWidth={1.75} />
          </button>
          <h1 className="min-w-0 truncate font-serif text-[28px] leading-tight tracking-[-0.01em]">
            {contact
              ? contact.name || t("Unnamed contact")
              : missing
                ? t("Contact not found")
                : " "}
          </h1>
        </div>
        {subline && (
          <p className="mt-1 pl-[34px] text-[13.5px] text-muted">{subline}</p>
        )}

        {contact && (
          <>
            <div className="mt-6 overflow-hidden rounded-xl border border-line">
              {contact.cells.map((c, i) => (
                <DataPointRow
                  key={keyOf(c)}
                  cell={c}
                  first={i === 0}
                  open={open.has(keyOf(c))}
                  onToggle={() => toggle(keyOf(c))}
                  copyable
                />
              ))}
            </div>

            <Section title={t("Companies")}>
              {contact.roles.length === 0 ? (
                <Empty text={t("No companies recorded")} />
              ) : (
                contact.roles.map((r, i) => (
                  <RoleRow key={r.id} role={r} first={i === 0} />
                ))
              )}
            </Section>

            <Section title={t("Known by")}>
              {contact.known_by.length === 0 ? (
                <Empty text={t("No one at Helbling recorded")} />
              ) : (
                contact.known_by.map((k, i) => (
                  <div
                    key={`${k.name}:${k.email}`}
                    className={`flex min-h-11 items-center gap-2.5 px-4 py-2 text-[14px] ${i ? "border-t border-line" : ""}`}
                  >
                    <Avatar name={k.name} photo={knownPhoto(k)} size={24} />
                    <span className="truncate">{k.name}</span>
                    {k.email && k.email !== k.name && (
                      <span className="truncate text-[13px] text-muted">
                        {k.email}
                      </span>
                    )}
                  </div>
                ))
              )}
            </Section>
          </>
        )}
      </div>
    </motion.div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-8">
      <h2 className="mb-2.5 text-[15px] font-medium">{title}</h2>
      <div className="overflow-hidden rounded-xl border border-line">
        {children}
      </div>
    </section>
  );
}

function Empty({ text }: { text: string }) {
  return (
    <p className="flex min-h-11 items-center px-4 text-[14px] text-muted">
      {text}
    </p>
  );
}

/** A role: the company (linking to it), the title, and "Former" once it ended. */
function RoleRow({ role, first }: { role: ContactRole; first: boolean }) {
  const { t } = useI18n();
  const title = role.title ?? role.function;
  const className = `grid min-h-11 w-full grid-cols-[200px_1fr_auto] items-center gap-3 px-4 py-2.5 text-left text-[14px] ${first ? "" : "border-t border-line"}`;
  const content = (
    <>
      <span className={`truncate ${role.current ? "" : "text-muted"}`}>
        {role.company_name ?? t("Unnamed company")}
      </span>
      <span className="truncate text-muted">{title}</span>
      <span className="flex items-center gap-2 text-[12.5px] text-muted">
        {!role.current && t("Former")}
        {role.company_id && (
          <ChevronRight size={14} strokeWidth={1.75} className="text-faint" />
        )}
      </span>
    </>
  );
  return role.company_id ? (
    <Link
      href={`/companies/${role.company_id}`}
      className={`${className} transition-colors hover:bg-canvas`}
    >
      {content}
    </Link>
  ) : (
    <div className={className}>{content}</div>
  );
}
