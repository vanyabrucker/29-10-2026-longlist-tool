"use client";

import Link from "next/link";
import { Linkedin } from "@/components/icons";
import { type Contact } from "@/lib/contacts";
import { useI18n } from "@/lib/i18n";
import { KnownByAvatars, Tooltip } from "./Contacts";

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
      <div className="grid min-h-[52px] grid-cols-[minmax(0,1.3fr)_minmax(0,1.4fr)_130px_28px_96px] items-center gap-x-4 px-4 py-2 text-[13px]">
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
        <div>
          {contact.linkedin ? (
            <a
              href={contact.linkedin}
              target="_blank"
              rel="noopener noreferrer"
              aria-label="LinkedIn"
              className="group/li relative flex size-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-subtle hover:text-ink"
            >
              <Linkedin size={15} strokeWidth={1.75} />
              <Tooltip
                label="LinkedIn"
                group="group-hover/li:opacity-100 group-hover/li:delay-150"
              />
            </a>
          ) : (
            <span className="flex size-7 items-center justify-center">
              {dash}
            </span>
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
