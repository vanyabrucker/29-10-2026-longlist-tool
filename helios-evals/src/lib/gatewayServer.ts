// Server-only: talks to helios-gateway with the session from an httpOnly
// cookie (the same scheme as helios-frontend, its own cookie name).

import { cookies } from "next/headers";
import { redirect } from "next/navigation";

export const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:8010";
export const SESSION_COOKIE = "helios_evals_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30;

export function gatewayHeaders(token?: string): Headers {
  const headers = new Headers();
  if (process.env.GATEWAY_SECRET) headers.set("x-gateway-secret", process.env.GATEWAY_SECRET);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

export const unreachable = () =>
  Response.json({ detail: `The gateway isn't reachable at ${GATEWAY_URL}.` }, { status: 502 });

export type Me = { email: string; name: string; role: string; is_dev: boolean };

/** The signed-in dev, or a redirect to /login (not signed in or not a dev). */
export async function requireDev(): Promise<Me> {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) redirect("/login");
  const response = await fetch(`${GATEWAY_URL}/me`, {
    headers: gatewayHeaders(token),
    cache: "no-store",
  });
  if (!response.ok) redirect("/login");
  const me = (await response.json()) as Me;
  if (!me.is_dev) redirect("/login?reason=dev");
  return me;
}
