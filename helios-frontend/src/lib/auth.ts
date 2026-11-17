// The signed-in user, from helios-gateway. The session itself is an httpOnly
// cookie set by /api/auth/login; this module only keeps the user it belongs
// to, shared by every component through a tiny external store.

import { useSyncExternalStore } from "react";
import { setLang } from "./i18n";

export type User = {
  id: string;
  email: string;
  name: string;
  /** member < admin < dev; each holds the rights of the ones before it. */
  role: "member" | "admin" | "dev";
  is_admin: boolean;
  is_dev: boolean;
  language: "en" | "de";
};

/** undefined while loading, null when signed out. */
let current: User | null | undefined;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

function set(user: User | null) {
  current = user;
  if (user) setLang(user.language);
  listeners.forEach((l) => l());
}

function load() {
  loading ??= fetch("/api/gateway/me", { cache: "no-store" })
    .then(async (r) => set(r.ok ? ((await r.json()) as User) : null))
    .catch(() => set(null))
    .finally(() => {
      loading = null;
    });
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (current === undefined) load();
  return () => listeners.delete(listener);
}

export function useUser(): User | null | undefined {
  return useSyncExternalStore(
    subscribe,
    () => current,
    () => undefined,
  );
}

export class SignInError extends Error {
  constructor(public kind: "credentials" | "unreachable") {
    super(kind);
  }
}

export async function signIn(email: string, password: string): Promise<User> {
  let response: Response;
  try {
    response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
  } catch {
    throw new SignInError("unreachable");
  }
  if (response.status === 401 || response.status === 422)
    throw new SignInError("credentials");
  if (!response.ok) throw new SignInError("unreachable");
  const user = (await response.json()) as User;
  set(user);
  return user;
}

export async function signOut() {
  await fetch("/api/auth/logout", { method: "POST" }).catch(() => {});
  set(null);
}

/** Saves name and/or language; the store updates once the gateway agrees. */
export async function updateProfile(
  patch: Partial<Pick<User, "name" | "language">>,
): Promise<User> {
  const response = await fetch("/api/gateway/me", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (response.status === 401) {
    set(null);
    throw new Error("Not signed in.");
  }
  if (!response.ok) throw new Error(`Saving failed (${response.status})`);
  const user = (await response.json()) as User;
  set(user);
  return user;
}

/** "Vanya" from "Vanya Brucker". */
export const firstName = (user: Pick<User, "name">) =>
  user.name.split(" ")[0] ?? user.name;
