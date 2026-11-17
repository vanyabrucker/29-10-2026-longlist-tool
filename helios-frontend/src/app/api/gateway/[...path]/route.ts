// Server-side proxy to helios-gateway, so the browser never sees the gateway's
// address, shared secret or session token. Passes the method and body through,
// adds the session from its httpOnly cookie, and streams the response back
// (including file downloads).

import type { NextRequest } from "next/server";
import {
  GATEWAY_URL,
  SESSION_COOKIE,
  gatewayHeaders,
  unreachable,
} from "@/lib/gatewayServer";

async function forward(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  // Login and logout go through /api/auth, which keeps the token out of the
  // browser; here they'd hand it to page scripts.
  if (path[0] === "auth")
    return Response.json({ detail: "Use /api/auth." }, { status: 404 });
  const url = new URL(request.url);
  const target = `${GATEWAY_URL}/${path.map(encodeURIComponent).join("/")}${url.search}`;
  const token = request.cookies.get(SESSION_COOKIE)?.value;
  const headers = gatewayHeaders(token);
  const type = request.headers.get("content-type");
  if (type) headers.set("content-type", type);
  const hasBody = !["GET", "HEAD"].includes(request.method);
  try {
    const response = await fetch(target, {
      method: request.method,
      headers,
      body: hasBody ? request.body : undefined,
      // Required by Node's fetch to stream a request body (uploads).
      ...(hasBody ? { duplex: "half" } : {}),
      cache: "no-store",
    } as RequestInit);
    const out = new Headers();
    for (const name of ["content-type", "content-disposition"]) {
      const value = response.headers.get(name);
      if (value) out.set(name, value);
    }
    return new Response(response.body, {
      status: response.status,
      headers: out,
    });
  } catch {
    return unreachable();
  }
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
