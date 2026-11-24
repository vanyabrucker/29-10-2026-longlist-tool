"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Logo } from "@/components/Logo";

function LoginForm() {
  const router = useRouter();
  const notDev = useSearchParams().get("reason") === "dev";
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(
    notDev ? "The eval dashboard is for devs only." : null,
  );
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const r = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    setBusy(false);
    if (r.ok) router.replace("/");
    else setError((await r.json().catch(() => ({}))).detail ?? "Couldn't sign in.");
  }

  return (
    <form onSubmit={submit} className="w-[340px]">
      <div className="mb-8 flex items-center gap-2.5">
        <Logo className="h-5 w-5" />
        <span className="font-serif text-[20px]">Helios Evals</span>
      </div>
      <h1 className="mb-1 font-serif text-[26px]">Sign in</h1>
      <p className="mb-6 text-[14px] text-muted">With your Helios account (devs only).</p>
      <label className="mb-1.5 block text-[13px] text-muted" htmlFor="email">Email</label>
      <input
        id="email"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className="mb-4 h-10 w-full rounded-lg border border-line px-3 text-[14px] outline-none focus:border-sky focus:ring-2 focus:ring-sky"
      />
      <label className="mb-1.5 block text-[13px] text-muted" htmlFor="password">Password</label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        className="mb-5 h-10 w-full rounded-lg border border-line px-3 text-[14px] outline-none focus:border-sky focus:ring-2 focus:ring-sky"
      />
      {error && <p className="mb-4 text-[13px] text-bad">{error}</p>}
      <button
        type="submit"
        disabled={busy || !email || !password}
        className="h-10 w-full rounded-full bg-ink text-[14px] text-white disabled:opacity-40"
      >
        Continue
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <main className="flex h-full items-center justify-center bg-canvas">
      <Suspense>
        <LoginForm />
      </Suspense>
    </main>
  );
}
