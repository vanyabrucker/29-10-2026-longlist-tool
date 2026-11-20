"use client";

import { motion } from "motion/react";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { Search, Table } from "@/components/icons";
import { gw } from "@/lib/gateway";
import { useI18n } from "@/lib/i18n";
import { formatEdited, type LonglistSummary } from "@/lib/longlists";
import { MEMBERS } from "@/lib/members";
import { Avatar } from "./Avatar";
import { LonglistDetail } from "./LonglistTable";

const EASE = [0.32, 0.72, 0, 1] as const;

const photoFor = (email: string) =>
  MEMBERS.find((m) => m.email === email)?.photo;

/** /longlists lists the team's lists; /longlists/[id] shows one. */
export function LonglistsPanel() {
  const pathname = usePathname();
  const id = pathname.split("/")[2];
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-tl-xl border-t border-l border-line bg-white">
      {id ? (
        <LonglistDetail key={id} id={decodeURIComponent(id)} />
      ) : (
        <LonglistIndex />
      )}
    </div>
  );
}

/** The team's longlists from the gateway, most recently edited first. */
function LonglistIndex() {
  const { t, lang, formatNumber } = useI18n();
  const router = useRouter();
  const [lists, setLists] = useState<LonglistSummary[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [query, setQuery] = useState("");
  useEffect(() => {
    let live = true;
    gw<LonglistSummary[]>("/longlists").then(
      (l) => live && setLists(l),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, []);
  const q = query.trim().toLowerCase();
  const items = (lists ?? []).filter(
    (item) =>
      !q ||
      item.name.toLowerCase().includes(q) ||
      item.owner.name.toLowerCase().includes(q),
  );

  const th = "h-9 px-3 font-normal";
  return (
    <>
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: EASE }}
        className="flex min-h-0 flex-1 flex-col px-8 pt-8"
      >
        <h1 className="font-serif text-[28px] leading-tight tracking-[-0.01em]">
          {t("Longlists")}
        </h1>
        <label className="mt-5 flex h-9 shrink-0 items-center gap-2.5 rounded-lg border border-line bg-white px-3 transition-shadow focus-within:border-[#c9d9ef] focus-within:ring-3 focus-within:ring-sky">
          <Search
            size={15}
            strokeWidth={1.75}
            className="shrink-0 text-muted"
          />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t("Search by list name or owner")}
            aria-label={t("Search by list name or owner")}
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted"
          />
        </label>

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto pb-8 [scrollbar-width:none]">
          <table className="w-full table-fixed border-separate border-spacing-0 text-left text-[14px]">
            <colgroup>
              <col />
              <col className="w-[240px]" />
              <col className="w-[140px]" />
              <col className="w-[190px]" />
            </colgroup>
            <thead className="sticky top-0 z-10 bg-white text-[12.5px] text-muted">
              <tr>
                <th className={`${th} border-b border-line`}>{t("Name")}</th>
                <th className={`${th} border-b border-line`}>{t("Owner")}</th>
                <th className={`${th} border-b border-line text-right`}>
                  {t("Size")}
                </th>
                <th className={`${th} border-b border-line`}>
                  {t("Last edited")}
                </th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                return (
                  <tr
                    key={item.id}
                    onClick={() =>
                      router.push(`/longlists/${encodeURIComponent(item.id)}`)
                    }
                    className="h-12 cursor-pointer transition-colors hover:bg-canvas"
                  >
                    <td className="border-b border-line px-3">
                      <span className="flex min-w-0 items-center gap-2.5">
                        <Table
                          size={15}
                          strokeWidth={1.75}
                          className="shrink-0 text-muted"
                        />
                        <span className="truncate font-medium">
                          {item.name}
                        </span>
                      </span>
                    </td>
                    <td className="border-b border-line px-3">
                      <span className="flex min-w-0 items-center gap-2">
                        <Avatar
                          name={item.owner.name}
                          photo={photoFor(item.owner.email)}
                          size={22}
                        />
                        <span className="truncate">{item.owner.name}</span>
                      </span>
                    </td>
                    <td className="border-b border-line px-3 text-right tabular-nums">
                      {t("{n} buyers", { n: formatNumber(item.size) })}
                    </td>
                    <td className="border-b border-line px-3 text-muted">
                      {formatEdited(item.edited_at, t, lang)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {lists && items.length === 0 && (
            <p className="py-10 text-center text-[13.5px] text-muted">
              {q
                ? t("No longlists match “{query}”.", { query })
                : t(
                    "No longlists yet. Import a spreadsheet onto a new list to start one.",
                  )}
            </p>
          )}
          {failed && (
            <p className="py-10 text-center text-[13.5px] text-muted">
              {t("Couldn't load longlists")}
            </p>
          )}
        </div>
      </motion.div>
    </>
  );
}
