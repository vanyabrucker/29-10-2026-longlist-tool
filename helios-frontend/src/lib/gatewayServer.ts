// Server-only helpers shared by the gateway proxy and the auth routes.
// The session token lives in an httpOnly cookie, so page scripts never see it;
// these routes turn it into the gateway's `Authorization: Bearer` header.

export const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:8010";
export const SESSION_COOKIE = "helios_session";
export const SESSION_MAX_AGE = 60 * 60 * 24 * 30; // matches the gateway's 30 days

/** Headers every gateway request carries: the shared secret and the session. */
export function gatewayHeaders(token?: string): Headers {
  const headers = new Headers();
  if (process.env.GATEWAY_SECRET)
    headers.set("x-gateway-secret", process.env.GATEWAY_SECRET);
  if (token) headers.set("authorization", `Bearer ${token}`);
  return headers;
}

export const unreachable = () =>
  Response.json(
    { detail: `The gateway isn't reachable at ${GATEWAY_URL}.` },
    { status: 502 },
  );
