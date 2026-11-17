// Ends the session in helios-gateway and clears the cookie (even if the
// gateway can't be reached, so signing out always works locally).

import { cookies } from "next/headers";
import {
  GATEWAY_URL,
  SESSION_COOKIE,
  gatewayHeaders,
} from "@/lib/gatewayServer";

export async function POST() {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (token)
    await fetch(`${GATEWAY_URL}/auth/logout`, {
      method: "POST",
      headers: gatewayHeaders(token),
      cache: "no-store",
    }).catch(() => {});
  store.delete(SESSION_COOKIE);
  return new Response(null, { status: 204 });
}
