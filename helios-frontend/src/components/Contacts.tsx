"use client";

import { motion } from "motion/react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { Loader, Search } from "@/components/icons";
import {
  initialsName,
  knownPhoto,
  type Contact,
  type ContactPage,
  type KnownBy,
} from "@/lib/contacts";
import { gw } from "@/lib/gateway";
import { useI18n, type MessageKey } from "@/lib/i18n";
import { Avatar } from "./Avatar";
import { ContactDetailPanel } from "./ContactDetail";

const EASE = [0.32, 0.72, 0, 1] as const;
const PAGE = 50;
const DEBOUNCE_MS = 200;
/** Known-by avatars shown before "+N". */
const MAX_KNOWN = 3;

const COLUMNS: { label: MessageKey; width?: string }[] = [
  { label: "Name" },
  { label: "Company", width: "w-[210px]" },
  { label: "Title", width: "w-[180px]" },
  { label: "Email", width: "w-[230px]" },
  { label: "Phone", width: "w-[140px]" },
  { label: "Known by", width: "w-[110px]" },
];

/** /contacts searches the contacts; /contacts/[id] shows one. */
export function ContactsPanel() {
  const pathname = usePathname();
  const id = pathname.split("/")[2];
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-tl-xl border-t border-l border-line bg-white">
      {id ? (
        <ContactDetailPanel key={id} id={decodeURIComponent(id)} />
      ) : (
        <ContactSearch />
      )}
    </div>
  );
}

function ContactSearch() {
  const { t, formatNumber } = useI18n();
  const router = useRouter();
  const params = useSearchParams();
  // The query lives in the URL, so coming back from a contact keeps it.
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [debounced, setDebounced] = useState(query.trim());
  const [result, setResult] = useState<ContactPage | null>(null);
  const [error, setError] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);

  useEffect(() => {
    const timer = setTimeout(() => {
      const q = query.trim();
      setDebounced(q);
      router.replace(
        q ? `/contacts?${new URLSearchParams({ q })}` : "/contacts",
        { scroll: false },
      );
    }, DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query, router]);

  const path = (offset: number) => {
    const p = new URLSearchParams({
      offset: String(offset),
      limit: String(PAGE),
    });
    if (debounced) p.set("q", debounced);
    return `/contacts?${p}`;
  };
  const request = path(0);

  useEffect(() => {
    let live = true;
    gw<ContactPage>(request).then(
      (page) => {
        if (!live) return;
        setResult(page);
        setError(false);
      },
      () => live && setError(true),
    );
    return () => {
      live = false;
    };
  }, [request]);

  const loadMore = async () => {
    if (!result) return;
    setLoadingMore(true);
    try {
      const next = await gw<ContactPage>(path(result.items.length));
      setResult({ ...next, items: [...result.items, ...next.items] });
    } catch {
      setError(true);
    } finally {
      setLoadingMore(false);
    }
  };

  const empty = result && result.total === 0;

  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, ease: EASE }}
      className="flex min-h-0 flex-1 flex-col px-8 pt-8"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="font-serif text-[28px] leading-tight tracking-[-0.01em]">
          {t("Contacts")}
        </h1>
        {result && result.total > 0 && (
          <span className="text-[13px] text-muted tabular-nums">
            {t(result.total === 1 ? "{n} contact" : "{n} contacts", {
              n: formatNumber(result.total),
            })}
          </span>
        )}
      </div>
      <label className="mt-5 flex h-9 shrink-0 items-center gap-2.5 rounded-lg border border-line bg-white px-3 transition-shadow focus-within:border-[#c9d9ef] focus-within:ring-3 focus-within:ring-sky">
        <Search size={15} strokeWidth={1.75} className="shrink-0 text-muted" />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t("Search by name, company, title or email")}
          aria-label={t("Search by name, company, title or email")}
          className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted"
        />
      </label>

      {error && !result ? (
        <EmptyState
          title={t("Couldn't load contacts")}
          text={t("The server isn't reachable. Try again in a moment.")}
        />
      ) : empty ? (
        debounced ? (
          <EmptyState
            title={t("No contacts found")}
            text={t(
              "Nothing matches “{query}”. Try part of a name, a company, a title or an email.",
              { query: debounced },
            )}
          />
        ) : (
          <EmptyState
            title={t("No contacts yet")}
            text={t(
              "Contacts appear here once people are added to the corpus.",
            )}
          />
        )
      ) : (
        <div className="mt-3 min-h-0 flex-1 overflow-auto pb-8 [scrollbar-width:none]">
          <table className="w-full min-w-[1000px] table-fixed border-separate border-spacing-0 text-left text-[14px]">
            <colgroup>
              {COLUMNS.map((c) => (
                <col key={c.label} className={c.width} />
              ))}
            </colgroup>
            <thead className="sticky top-0 z-10 bg-white text-[12.5px] text-muted">
              <tr>
                {COLUMNS.map((c) => (
                  <th
                    key={c.label}
                    className="h-9 border-b border-line px-3 font-normal"
                  >
                    {t(c.label)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result?.items.map((contact) => (
                <Row
                  key={contact.id}
                  contact={contact}
                  onOpen={() => router.push(`/contacts/${contact.id}`)}
                />
              ))}
            </tbody>
          </table>
          {result && result.items.length < result.total && (
            <div className="flex justify-center pt-5">
              <button
                type="button"
                onClick={loadMore}
                disabled={loadingMore}
                className="flex h-8 items-center gap-1.5 rounded-full border border-line px-3.5 text-[13.5px] font-medium transition-colors hover:bg-subtle disabled:text-muted"
              >
                {loadingMore && (
                  <Loader
                    size={13}
                    strokeWidth={1.75}
                    className="animate-spin"
                  />
                )}
                {t("Show more")}
              </button>
            </div>
          )}
        </div>
      )}
    </motion.div>
  );
}

const td = "border-b border-line px-3";

function Row({ contact, onOpen }: { contact: Contact; onOpen: () => void }) {
  const { t } = useI18n();
  const [role, ...more] = contact.roles;
  return (
    <tr
      onClick={onOpen}
      className="h-11 cursor-pointer transition-colors hover:bg-canvas"
    >
      <td className={td}>
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar name={initialsName(contact)} size={24} />
          <span className="truncate font-medium">
            {contact.name || t("Unnamed contact")}
          </span>
        </span>
      </td>
      <td className={td}>
        <span className="flex min-w-0 items-center gap-1.5">
          <Text value={role?.company_name} />
          {more.length > 0 && (
            <span className="shrink-0 text-[12.5px] text-faint tabular-nums">
              +{more.length}
            </span>
          )}
        </span>
      </td>
      <td className={td}>
        <Text value={role ? (role.title ?? role.function) : null} />
      </td>
      <td className={td}>
        <Text value={contact.email} />
      </td>
      <td className={td}>
        <Text value={contact.phone} numeric />
      </td>
      <td className={td}>
        <KnownByAvatars people={contact.known_by} />
      </td>
    </tr>
  );
}

function Text({
  value,
  numeric,
}: {
  value?: string | null;
  numeric?: boolean;
}) {
  return value ? (
    <span className={`block truncate ${numeric ? "tabular-nums" : ""}`}>
      {value}
    </span>
  ) : (
    <span className="text-faint">–</span>
  );
}

/** Who at Helbling knows a contact: overlapping portraits (or initials),
 * each name in a black tooltip; "–" when nobody is recorded. */
export function KnownByAvatars({
  people,
  size = 22,
}: {
  people: KnownBy[];
  size?: number;
}) {
  if (people.length === 0) return <span className="text-faint">–</span>;
  const shown = people.slice(0, MAX_KNOWN);
  const rest = people.slice(MAX_KNOWN);
  return (
    <span className="flex items-center">
      {shown.map((k, i) => (
        <span
          key={`${k.name}:${k.email}`}
          className={`group/known relative flex rounded-full ring-2 ring-white ${i ? "-ml-1.5" : ""}`}
        >
          <Avatar name={k.name} photo={knownPhoto(k)} size={size} />
          <Tooltip
            label={k.name}
            group="group-hover/known:opacity-100 group-hover/known:delay-150"
          />
        </span>
      ))}
      {rest.length > 0 && (
        <span className="group/rest relative ml-1.5 flex text-[12.5px] text-muted tabular-nums">
          +{rest.length}
          <Tooltip
            label={rest.map((k) => k.name).join(", ")}
            group="group-hover/rest:opacity-100 group-hover/rest:delay-150"
          />
        </span>
      )}
    </span>
  );
}

export function Tooltip({ label, group }: { label: string; group: string }) {
  return (
    <span
      role="tooltip"
      className={`pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 -translate-x-1/2 rounded-md bg-ink px-2 py-1 text-[12px] leading-[14px] font-medium whitespace-nowrap text-white opacity-0 transition-opacity duration-150 ${group}`}
    >
      {label}
    </span>
  );
}

// Slightly above the middle, like the home greeting.
function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center pb-[12vh] text-center">
      <span className="flex size-9 items-center justify-center rounded-lg border border-line bg-white">
        <Search size={16} strokeWidth={1.75} />
      </span>
      <h2 className="mt-5 text-[15px] font-medium">{title}</h2>
      <p className="mt-1.5 max-w-[360px] text-[13px] text-muted">{text}</p>
    </div>
  );
}
