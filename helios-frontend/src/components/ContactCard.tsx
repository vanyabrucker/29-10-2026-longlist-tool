"use client";

import Link from "next/link";
import { type Contact } from "@/lib/contacts";
import { useI18n } from "@/lib/i18n";

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
  return (
    <div
      className={
        compact
          ? "flex flex-col gap-0.5 text-[13px] leading-[18px]"
          : "flex flex-col gap-0.5 px-4 py-3 text-[13.5px] leading-5"
      }
    >
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
