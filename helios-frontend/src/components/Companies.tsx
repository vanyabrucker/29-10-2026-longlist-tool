"use client";

import { motion } from "motion/react";
import { Search } from "react-feather";
import { useI18n } from "@/lib/i18n";

const EASE = [0.32, 0.72, 0, 1] as const;

/** Company search: an inert search field over an empty state. */
export function CompaniesPanel() {
  const { t } = useI18n();

  return (
    <div className="flex h-full min-w-0 flex-1 flex-col overflow-hidden rounded-tl-xl border-t border-l border-line bg-white">
      <motion.div
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3, ease: EASE }}
        className="flex min-h-0 flex-1 flex-col px-8 pt-8"
      >
        <h1 className="font-serif text-[28px] leading-tight tracking-[-0.01em]">
          {t("Companies")}
        </h1>
        <label className="mt-5 flex h-9 items-center gap-2.5 rounded-lg border border-line bg-white px-3 transition-shadow focus-within:border-[#c9d9ef] focus-within:ring-3 focus-within:ring-sky">
          <Search
            size={15}
            strokeWidth={1.75}
            className="shrink-0 text-muted"
          />
          <input
            placeholder={t("Search by company name or website")}
            aria-label={t("Search by company name or website")}
            className="min-w-0 flex-1 bg-transparent text-[14px] outline-none placeholder:text-muted"
          />
        </label>

        {/* Slightly above the middle, like the home greeting. */}
        <div className="flex flex-1 flex-col items-center justify-center pb-[12vh] text-center">
          <span className="flex size-9 items-center justify-center rounded-lg border border-line bg-white">
            <Search size={16} strokeWidth={1.75} />
          </span>
          <h2 className="mt-5 text-[15px] font-medium">
            {t("Find companies instantly")}
          </h2>
          <p className="mt-1.5 text-[13px] text-muted">
            {t(
              "Search companies by legal name or website for precise results.",
            )}
          </p>
        </div>
      </motion.div>
    </div>
  );
}
