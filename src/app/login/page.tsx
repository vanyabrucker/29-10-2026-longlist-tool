"use client";

import Image from "next/image";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Award, Shield, TrendingUp, Zap } from "react-feather";
import { Logo } from "@/components/Logo";
import { signIn } from "@/lib/auth";
import { useI18n, type MessageKey } from "@/lib/i18n";
import heroImage from "../../../public/login-background.png";

const FEATURES: { icon: typeof Award; title: MessageKey; sub: MessageKey }[] = [
  { icon: TrendingUp, title: "100M+ Companies", sub: "Global database" },
  { icon: Award, title: "Complete Data", sub: "Internal, proprietary, public" },
  { icon: Zap, title: "Real-time Data", sub: "Live search for anything" },
  { icon: Shield, title: "Verified Data", sub: "SOC 2 compliant" },
];

export default function LoginPage() {
  const { t } = useI18n();
  const router = useRouter();
  const [email, setEmail] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    signIn(email.trim() || "demo@helios.ai");
    router.push("/");
  }

  return (
    <main className="flex h-full min-h-screen">
      {/* Left: hero */}
      <section className="relative hidden w-[36.2%] shrink-0 overflow-hidden bg-[#0b0e14] text-white lg:block">
        {/* Always full image height; the panel crops the sides around the center. */}
        <Image
          src={heroImage}
          alt=""
          priority
          sizes="(min-width: 1024px) 100vh, 0px"
          placeholder="blur"
          className="absolute top-0 left-1/2 h-full w-auto max-w-none -translate-x-1/2"
        />
        {/* Darkens the bright photo enough for the white copy to stay legible. */}
        <div
          aria-hidden
          className="absolute inset-0 bg-gradient-to-b from-black/45 via-black/35 to-black/55"
        />

        <div className="relative px-[2.75rem] pt-[30vh]">
          <h1 className="font-serif text-[2.1rem] leading-[1.15] tracking-[-0.01em]">
            {t("First-move intelligence")}
            <br />
            {t("for Helbling")}
          </h1>

          <ul className="mt-10 grid w-max grid-cols-[auto_auto] gap-x-8 gap-y-10 pl-4">
            {FEATURES.map(({ icon: Icon, title, sub }) => (
              <li key={title} className="flex items-center gap-4">
                <Icon size={16} strokeWidth={1.75} className="shrink-0" />
                <div>
                  <div className="text-[15px] leading-snug font-medium whitespace-nowrap">
                    {t(title)}
                  </div>
                  <div className="mt-1 text-[12px] whitespace-nowrap text-white/80">
                    {t(sub)}
                  </div>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <div aria-hidden className="hidden w-2 shrink-0 bg-sky lg:block" />

      {/* Right: form */}
      <section className="flex flex-1 items-center justify-center px-6">
        <div className="w-full max-w-[21rem]">
          <div className="flex items-center justify-center gap-5">
            {/* Nudged up to center on the serif cap height rather than the line box. */}
            <Logo className="relative -top-[3.5px] size-[28px]" />
            <h2 className="font-serif text-[2.25rem] leading-none tracking-[-0.01em]">
              Helios
            </h2>
          </div>

          <form onSubmit={submit} className="mt-10">
            <label
              htmlFor="email"
              className="block text-[13px] font-medium text-ink"
            >
              {t("Email")}
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              placeholder={t("Enter your email...")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="mt-1.5 h-[2.25rem] w-full rounded-lg border border-line px-3 text-[14px] outline-none placeholder:text-muted focus:border-[#c9c9ce] focus:ring-3 focus:ring-sky"
            />
            <button
              type="submit"
              className="mt-6 h-[2.25rem] w-full rounded-lg bg-ink text-[14px] font-medium text-white transition-colors hover:bg-[#26262a]"
            >
              {t("Continue")}
            </button>
          </form>

          <p className="mt-8 text-center text-[13px] text-muted">
            {t("Don't have an account?")}{" "}
            <button
              type="button"
              className="font-medium text-ink underline underline-offset-2"
            >
              {t("Request access")}
            </button>
          </p>
        </div>
      </section>
    </main>
  );
}
