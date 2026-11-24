// Proxy to helios-gateway for the feedback queue: adds the session from the
// httpOnly cookie. Only the feedback endpoints pass.

import type { NextRequest } from "next/server";
import { GATEWAY_URL, SESSION_COOKIE, gatewayHeaders, unreachable } from "@/lib/gatewayServer";

async function forward(
  request: NextRequest,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  if (path[0] !== "feedback") return Response.json({ detail: "Not found." }, { status: 404 });
  const url = new URL(request.url);
  const headers = gatewayHeaders(request.cookies.get(SESSION_COOKIE)?.value);
  const type = request.headers.get("content-type");
  if (type) headers.set("content-type", type);
  try {
    const response = await fetch(
      `${GATEWAY_URL}/${path.map(encodeURIComponent).join("/")}${url.search}`,
      {
        method: request.method,
        headers,
        body: ["GET", "HEAD"].includes(request.method) ? undefined : await request.text(),
        cache: "no-store",
      },
    );
    return new Response(response.body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") ?? "application/json" },
    });
  } catch {
    return unreachable();
  }
}

export const GET = forward;
export const PATCH = forward;
