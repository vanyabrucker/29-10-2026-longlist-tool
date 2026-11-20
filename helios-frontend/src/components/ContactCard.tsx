"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Check, Copy } from "@/components/icons";
import { type Contact } from "@/lib/contacts";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { KnownByAvatars } from "./Contacts";
import { HoverTooltip } from "./HoverTooltip";

/** Columns of the card's rows and its header. The LinkedIn link's box starts
 * 8px left of the text (`-ml-2`), so text and header labels line up. */
const GRID =
  "grid grid-cols-[minmax(0,1.3fr)_minmax(0,1.3fr)_130px_minmax(0,1fr)_96px] items-center gap-x-4 px-4";

const HEADER: { label: MessageKey; end?: boolean }[] = [
  { label: "Name" },
  { label: "Email" },
  { label: "Phone" },
  { label: "LinkedIn" },
  { label: "Known by", end: true },
];

/** The header row above a card of `ContactCard` rows. */
export function ContactCardHeader() {
  const { t } = useI18n();
  return (
    <div className={`${GRID} h-9 text-[12.5px] text-muted`}>
      {HEADER.map((h) => (
        <span key={h.label} className={`truncate ${h.end ? "text-right" : ""}`}>
          {t(h.label)}
        </span>
      ))}
    </div>
  );
}

/** A LinkedIn profile as its shortened link. On hover it gets an input-like
 * box and a copy button slides in on its left. */
function LinkedInCell({ url }: { url: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const shown = url.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/+$/, "");

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  // The check shows only when the link really was copied; a browser that
  // refuses clipboard access leaves the copy icon as it was.
  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
    } catch {
      return;
    }
    setCopied(true);
  }

  return (
    <div className="group/li relative -ml-2 flex h-8 min-w-0 items-center rounded-lg border border-transparent transition-colors hover:border-line">
      <motion.button
        type="button"
        aria-label={t("Copy link")}
        onClick={copy}
        whileTap={{ scale: 0.85 }}
        className="absolute left-1 flex size-6 items-center justify-center rounded-md text-muted opacity-0 transition-[opacity,color,background-color] group-hover/li:opacity-100 hover:bg-subtle hover:text-ink focus-visible:opacity-100"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={copied ? "check" : "copy"}
            initial={{ scale: 0.6, opacity: 0 }}
            animate={{ scale: copied ? [0.6, 1.25, 1] : 1, opacity: 1 }}
            exit={{ scale: 0.6, opacity: 0 }}
            transition={{ duration: copied ? 0.3 : 0.15, ease: "easeOut" }}
            className="flex"
          >
            {copied ? (
              <Check size={13} strokeWidth={2} />
            ) : (
              <Copy size={13} strokeWidth={1.75} />
            )}
          </motion.span>
        </AnimatePresence>
        <HoverTooltip label={copied ? t("Copied") : t("Copy link")} />
      </motion.button>
      <a
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="block min-w-0 truncate pr-2 pl-2 transition-[padding] duration-150 group-hover/li:pl-8 hover:underline"
      >
        {shown}
      </a>
    </div>
  );
}

/** A person at a company: name (links to the contact), role at this company,
 * email, phone, LinkedIn and who at Helbling knows them. Missing lines are
 * left out. `compact` is the narrow stacked form for popovers (no padding or
 * border of its own); otherwise it is a row in a bordered card. */
export function ContactCard({
  contact,
  compact,
}: {
  contact: Contact;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const role = contact.role;
  const roleLine = role ? (role.title ?? role.function ?? "") : "";
  const known = contact.known_by.map((k) => k.name).join(", ");
  const link =
    "text-ink underline decoration-line underline-offset-2 transition-colors hover:decoration-ink";
  if (!compact) {
    const dash = <span className="text-faint">–</span>;
    return (
      <div className={`${GRID} min-h-[52px] py-2 text-[13px]`}>
        <div className="min-w-0">
          <Link
            href={`/contacts/${encodeURIComponent(contact.id)}`}
            className="block w-fit max-w-full truncate text-[14px] font-medium text-ink hover:underline"
          >
            {contact.name || t("Unnamed contact")}
          </Link>
          {roleLine && <div className="truncate text-muted">{roleLine}</div>}
        </div>
        <div className="min-w-0">
          {contact.email ? (
            <a
              href={`mailto:${contact.email}`}
              className="block w-fit max-w-full truncate hover:underline"
            >
              {contact.email}
            </a>
          ) : (
            dash
          )}
        </div>
        <div className="min-w-0 tabular-nums">
          {contact.phone ? (
            <a
              href={`tel:${contact.phone}`}
              className="block w-fit max-w-full truncate hover:underline"
            >
              {contact.phone}
            </a>
          ) : (
            dash
          )}
        </div>
        <div className="min-w-0">
          {contact.linkedin ? <LinkedInCell url={contact.linkedin} /> : dash}
        </div>
        <div className="flex justify-end">
          <KnownByAvatars people={contact.known_by} />
        </div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-0.5 text-[13px] leading-[18px]">
      <Link
        href={`/contacts/${encodeURIComponent(contact.id)}`}
        className="w-fit font-medium text-ink hover:underline"
      >
        {contact.name || t("Unnamed contact")}
      </Link>
      {roleLine && <span className="text-muted">{roleLine}</span>}
      {contact.email && (
        <a href={`mailto:${contact.email}`} className={`w-fit ${link}`}>
          {contact.email}
        </a>
      )}
      {contact.phone && (
        <a
          href={`tel:${contact.phone}`}
          className={`w-fit tabular-nums ${link}`}
        >
          {contact.phone}
        </a>
      )}
      {contact.linkedin && (
        <a
          href={contact.linkedin}
          target="_blank"
          rel="noopener noreferrer"
          className={`w-fit ${link}`}
        >
          LinkedIn
        </a>
      )}
      {known && (
        <span className="text-faint">
          {t("Known by {names}", { names: known })}
        </span>
      )}
    </div>
  );
}
