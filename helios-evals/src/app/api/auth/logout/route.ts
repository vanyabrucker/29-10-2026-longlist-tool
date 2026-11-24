import { cookies } from "next/headers";
import { GATEWAY_URL, SESSION_COOKIE, gatewayHeaders } from "@/lib/gatewayServer";

export async function POST() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) {
    await fetch(`${GATEWAY_URL}/auth/logout`, {
      method: "POST",
      headers: gatewayHeaders(token),
      cache: "no-store",
    }).catch(() => undefined); // signing out locally works even if the gateway is down
  }
  jar.delete(SESSION_COOKIE);
  return Response.json({ ok: true });
}
