"use client";

import { motion } from "motion/react";
import { useState } from "react";
import { Search, Table } from "react-feather";
import { useI18n, type Translate } from "@/lib/i18n";
import { LONGLISTS, type LonglistItem } from "@/lib/longlists";
import { memberNamed } from "@/lib/members";
import { BUYER_LISTS } from "@/lib/research";
import { Avatar } from "./Avatar";

const EASE = [0.32, 0.72, 0, 1] as const;

// Same names as the research table's tabs: "Vetora Clinics – Strategic buyers".
const LIST_TITLE = Object.fromEntries(BUYER_LISTS.map((l) => [l.id, l.title]));

const titleOf = (item: LonglistItem, t: Translate) =>
  `${item.target} – ${t(LIST_TITLE[item.kind])}`;

// "Today, 09:12", "Yesterday, 16:40", then the date.
function formatEdited(minutesAgo: number, t: Translate, locale: string) {
  const at = new Date(Date.now() - minutesAgo * 60_000);
  const time = at.toLocaleTimeString(locale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const today = new Date();
  const days = Math.round(
    (new Date(today.toDateString()).getTime() -
      new Date(at.toDateString()).getTime()) /
      86_400_000,
  );
  if (days === 0) return t("Today, {time}", { time });
  if (days === 1) return t("Yesterday, {time}", { time });
  return at.toLocaleDateString(locale, {
    day: "numeric",
    month: "short",
    year: "numeric",
  });
}

/** The team's longlists, most recently edited first. Rows are inert. */
export function LonglistsPanel() {
  const { t, lang, formatNumber } = useI18n();
  const locale = lang === "de" ? "de-CH" : "en-GB";
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const items = [...LONGLISTS]
    .sort((a, b) => a.minutesAgo - b.minutesAgo)
    .filter(
      (item) =>
        !q ||
        titleOf(item, t).toLowerCase().includes(q) ||
        item.owner.toLowerCase().includes(q),
    );

  const th = "h-9 px-3 font-normal";
  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-tl-xl border-t border-l border-line bg-white">
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

        <div className="mt-4 min-h-0 flex-1 overflow-y-auto pb-8">
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
                const owner = memberNamed(item.owner);
                return (
                  <tr
                    key={item.id}
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
                          {titleOf(item, t)}
                        </span>
                      </span>
                    </td>
                    <td className="border-b border-line px-3">
                      <span className="flex min-w-0 items-center gap-2">
                        <Avatar
                          name={owner.name}
                          photo={owner.photo}
                          size={22}
                        />
                        <span className="truncate">{owner.name}</span>
                      </span>
                    </td>
                    <td className="border-b border-line px-3 text-right tabular-nums">
                      {t("{n} buyers", { n: formatNumber(item.size) })}
                    </td>
                    <td className="border-b border-line px-3 text-muted">
                      {formatEdited(item.minutesAgo, t, locale)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {items.length === 0 && (
            <p className="py-10 text-center text-[13.5px] text-muted">
              {t("No longlists match “{query}”.", { query })}
            </p>
          )}
        </div>
      </motion.div>
    </div>
  );
}
