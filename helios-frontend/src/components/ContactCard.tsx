"use client";

import Link from "next/link";
import { type Contact } from "@/lib/contacts";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { KnownByAvatars } from "./Contacts";
import { CopyableLink, shortLinkedIn } from "./CopyableLink";

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
              text={shortLinkedIn(contact.linkedin)}
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
        <CopyableLink
          small
          href={`mailto:${contact.email}`}
          text={contact.email}
          value={contact.email}
          copyLabel="Copy email"
        />
      )}
      {contact.phone && (
        <CopyableLink
          small
          href={`tel:${contact.phone}`}
          text={contact.phone}
          value={contact.phone}
          copyLabel="Copy phone number"
          numeric
        />
      )}
      {contact.linkedin && (
        <CopyableLink
          small
          href={contact.linkedin}
          text={shortLinkedIn(contact.linkedin)}
          value={contact.linkedin}
          copyLabel="Copy link"
          external
        />
      )}
      {known && (
        <span className="text-faint">
          {t("Known by {names}", { names: known })}
        </span>
      )}
    </div>
  );
}
