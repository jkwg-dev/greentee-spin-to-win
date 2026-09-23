/**
 * Small response helpers shared by the API and proxy routes.
 */

/**
 * UI extensions run in a Web Worker with a null origin, so the status
 * endpoint must allow any origin. The session token, not the origin, is
 * what authenticates the request.
 */
export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "600",
};

export function json(data: unknown, init: { status?: number; cors?: boolean } = {}): Response {
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  if (init.cors) for (const [k, v] of Object.entries(CORS_HEADERS)) headers.set(k, v);
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export function methodNotAllowed(allow: string, cors = false): Response {
  const res = json({ error: "method_not_allowed" }, { status: 405, cors });
  res.headers.set("Allow", allow);
  return res;
}

export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = (await request.json()) as unknown;
    return body && typeof body === "object" ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
