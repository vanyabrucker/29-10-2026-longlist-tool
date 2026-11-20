"use client";

import { useI18n, type MessageKey } from "@/lib/i18n";

// Third-party notices. Names and copyright lines stay as the authors wrote
// them; the headings and explanations are translated.

const MIT_NOTICES: { name: string; copyright: string }[] = [
  {
    name: "Feather",
    copyright: "Copyright 2013-2017 Cole Bemis",
  },
  {
    name: "Next.js",
    copyright: "Copyright 2025 Vercel, Inc.",
  },
  {
    name: "React and React DOM",
    copyright: "Copyright Meta Platforms, Inc. and affiliates.",
  },
  {
    name: "Motion",
    copyright: "Copyright 2024 Motion B.V.",
  },
  {
    name: "react-markdown",
    copyright: "Copyright Espen Hovlandsdal",
  },
  {
    name: "remark-gfm",
    copyright: "Copyright Titus Wormer",
  },
];

const FONTS: { name: string; copyright: string }[] = [
  { name: "Lora", copyright: "Copyright 2011 The Lora Project Authors" },
  { name: "DM Sans", copyright: "Copyright 2014 The DM Sans Project Authors" },
  { name: "DM Mono", copyright: "Copyright 2020 The DM Mono Project Authors" },
];

function Section({
  title,
  children,
}: {
  title: MessageKey;
  children: React.ReactNode;
}) {
  const { t } = useI18n();
  return (
    <section className="mt-9 first:mt-0">
      <h2 className="mb-3 text-[15px] font-medium">{t(title)}</h2>
      {children}
    </section>
  );
}

export function Impressum() {
  const { t } = useI18n();
  return (
    <div>
      <div className="mb-7">
        <h1 className="font-serif text-[28px] leading-tight tracking-[-0.01em]">
          {t("Impressum")}
        </h1>
      </div>

      <p className="mb-9 text-[14px] leading-relaxed text-muted">
        {t(
          "Helios is built with the open-source software, icons and fonts below. Their notices are reproduced here as their licences require.",
        )}
      </p>

      <Section title="Icons and software">
        <div className="rounded-xl border border-line px-4">
          {MIT_NOTICES.map((n) => (
            <div
              key={n.name}
              className="border-b border-hairline py-3 last:border-b-0"
            >
              <span className="text-[14px] font-medium">{n.name}</span>
              <div className="mt-0.5 text-[13px] text-muted">
                {n.copyright}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-[13px] leading-relaxed text-muted">
          {t(
            "These icons and this software are licensed under the",
          )}{" "}
          <a
            href="https://mit-license.org"
            target="_blank"
            rel="noreferrer"
            className="text-ink underline underline-offset-2"
          >
            MIT License
          </a>
          .
        </p>
      </Section>

      <Section title="Fonts">
        <div className="rounded-xl border border-line px-4">
          {FONTS.map((f) => (
            <div
              key={f.name}
              className="border-b border-hairline py-3 last:border-b-0"
            >
              <span className="text-[14px] font-medium">{f.name}</span>
              <div className="mt-0.5 text-[13px] text-muted">
                {f.copyright}
              </div>
            </div>
          ))}
        </div>
        <p className="mt-4 text-[13px] leading-relaxed text-muted">
          {t(
            "These fonts are licensed under the",
          )}{" "}
          <a
            href="https://openfontlicense.org"
            target="_blank"
            rel="noreferrer"
            className="text-ink underline underline-offset-2"
          >
            SIL Open Font License, Version 1.1
          </a>
          .
        </p>
      </Section>

      <Section title="Other packages">
        <p className="text-[13px] leading-relaxed text-muted">
          {t(
            "The packages these depend on carry their own licences, mostly MIT and ISC.",
          )}
        </p>
      </Section>
    </div>
  );
}
