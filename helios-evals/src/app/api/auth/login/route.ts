// Signs in against helios-gateway; the session token stays in an httpOnly cookie.

import { cookies } from "next/headers";
import {
  GATEWAY_URL,
  SESSION_COOKIE,
  SESSION_MAX_AGE,
  gatewayHeaders,
  unreachable,
} from "@/lib/gatewayServer";

export async function POST(request: Request) {
  const headers = gatewayHeaders();
  headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await fetch(`${GATEWAY_URL}/auth/login`, {
      method: "POST",
      headers,
      body: await request.text(),
      cache: "no-store",
    });
  } catch {
    return unreachable();
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) return Response.json(data, { status: response.status });
  if (!data.user?.is_dev)
    return Response.json({ detail: "The eval dashboard is for devs only." }, { status: 403 });
  (await cookies()).set(SESSION_COOKIE, data.token, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: SESSION_MAX_AGE,
  });
  return Response.json(data.user);
}
