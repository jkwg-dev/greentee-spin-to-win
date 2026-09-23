/**
 * POST /api/spin/status  { orderId }
 *
 * Called by the Thank you page extension. Authenticated with the extension's
 * session token (Bearer JWT signed with the app secret). Responds with CORS
 * headers because extensions run in a worker with a null origin.
 */
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { getEnv } from "~/config/env.server";
import { getAdminClient } from "~/lib/admin.server";
import { json, methodNotAllowed, preflight, readJsonBody } from "~/lib/http.server";
import { log } from "~/lib/log.server";
import { normalizeOrderId } from "~/lib/outcome";
import { bearerToken, verifySessionToken } from "~/lib/session-token.server";
import { SpinError, getSpinStatus } from "~/lib/spin.server";

// React Router sends OPTIONS (the CORS preflight) to the loader, not the action.
export function loader({ request }: LoaderFunctionArgs) {
  if (request.method === "OPTIONS") return preflight();
  return methodNotAllowed("POST, OPTIONS", true);
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") return preflight();
  if (request.method !== "POST") return methodNotAllowed("POST, OPTIONS", true);

  const env = getEnv();
  const session = verifySessionToken(bearerToken(request.headers.get("authorization")), {
    apiSecret: env.shopifyApiSecret,
    apiKey: env.shopifyApiKey,
    shopDomain: env.shopDomain,
  });
  if (!session.ok) {
    log.warn("status.unauthorized", { reason: session.reason });
    return json({ error: "unauthorized", reason: session.reason }, { status: 401, cors: true });
  }

  const body = await readJsonBody(request);
  let orderId: string;
  try {
    orderId = normalizeOrderId(String(body?.orderId ?? ""));
  } catch {
    return json(
      { error: "bad_request", message: "orderId is required" },
      { status: 400, cors: true },
    );
  }

  try {
    const status = await getSpinStatus(orderId, { admin: getAdminClient(), env });
    return json(status, { cors: true });
  } catch (error) {
    if (error instanceof SpinError)
      return json(error.toJSON(), { status: error.status, cors: true });
    log.error("status.failed", { orderId, error });
    return json({ error: "internal", retryable: true }, { status: 500, cors: true });
  }
}
