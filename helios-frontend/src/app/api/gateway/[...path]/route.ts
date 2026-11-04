// Server-side proxy to helios-gateway, so the browser never sees the gateway's
// address or shared secret. Passes the method, body and the acting user's
// email through; streams the response back (including file downloads).

const GATEWAY_URL = process.env.GATEWAY_URL ?? "http://localhost:8010";

async function forward(
  request: Request,
  { params }: { params: Promise<{ path: string[] }> },
) {
  const { path } = await params;
  const url = new URL(request.url);
  const target = `${GATEWAY_URL}/${path.map(encodeURIComponent).join("/")}${url.search}`;
  const headers = new Headers();
  for (const name of ["content-type", "x-user-email"]) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (process.env.GATEWAY_SECRET)
    headers.set("x-gateway-secret", process.env.GATEWAY_SECRET);
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
    return Response.json(
      { detail: `The gateway isn't reachable at ${GATEWAY_URL}.` },
      { status: 502 },
    );
  }
}

export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const PATCH = forward;
export const DELETE = forward;
