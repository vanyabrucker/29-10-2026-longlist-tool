"use client";

import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { useEffect, useState } from "react";
import { Check, Copy } from "@/components/icons";
import { type Contact } from "@/lib/contacts";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { KnownByAvatars } from "./Contacts";
import { HoverTooltip } from "./HoverTooltip";

/** Columns of the card's rows and its header. A copyable link's box starts
 * 8px left of its text (`-ml-2`), so text and header labels line up. */
const GRID =
  "grid grid-cols-[minmax(0,1.3fr)_minmax(0,1.3fr)_150px_minmax(0,1fr)_96px] items-center gap-x-4 px-4";

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

/** A contact detail (email, phone, LinkedIn) as a link that hugs its text.
 * On hover it gets an input-like box and a copy button slides in on its
 * right; the button copies `value`, which may differ from the shown text. */
function CopyableLink({
  href,
  text,
  value,
  copyLabel,
  external,
  numeric,
}: {
  href: string;
  text: string;
  value: string;
  copyLabel: MessageKey;
  external?: boolean;
  numeric?: boolean;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  // The check shows only when the value really was copied; a browser that
  // refuses clipboard access leaves the copy icon as it was.
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      return;
    }
    setCopied(true);
  }

  return (
    <div className="group/copy relative -ml-2 flex h-8 w-fit max-w-[calc(100%+8px)] min-w-0 items-center rounded-lg border border-transparent transition-colors hover:border-line">
      <a
        href={href}
        {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
        className={`block min-w-0 truncate pr-2 pl-2 transition-[padding] duration-150 group-hover/copy:pr-8 hover:underline ${numeric ? "tabular-nums" : ""}`}
      >
        {text}
      </a>
      <motion.button
        type="button"
        aria-label={t(copyLabel)}
        onClick={copy}
        whileTap={{ scale: 0.85 }}
        className="absolute right-1 flex size-6 items-center justify-center rounded-md text-muted opacity-0 transition-[opacity,color,background-color] group-hover/copy:opacity-100 hover:bg-subtle hover:text-ink focus-visible:opacity-100"
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
        <HoverTooltip label={copied ? t("Copied") : t(copyLabel)} />
      </motion.button>
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
            <CopyableLink
              href={`mailto:${contact.email}`}
              text={contact.email}
              value={contact.email}
              copyLabel="Copy email"
            />
          ) : (
            dash
          )}
        </div>
        <div className="min-w-0">
          {contact.phone ? (
            <CopyableLink
              href={`tel:${contact.phone}`}
              text={contact.phone}
              value={contact.phone}
              copyLabel="Copy phone number"
              numeric
            />
          ) : (
            dash
          )}
        </div>
        <div className="min-w-0">
          {contact.linkedin ? (
            <CopyableLink
              href={contact.linkedin}
              text={contact.linkedin
                .replace(/^https?:\/\/(www\.)?/i, "")
                .replace(/\/+$/, "")}
              value={contact.linkedin}
              copyLabel="Copy link"
              external
            />
          ) : (
            dash
          )}
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
