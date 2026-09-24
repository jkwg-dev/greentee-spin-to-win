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
import { logged } from "~/lib/request-log.server";
import { OrderIdError, normalizeOrderId } from "~/lib/outcome";
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
    altDomains: env.shopAltDomains,
  });
  if (!session.ok) {
    log.warn("status.unauthorized", {
      reason: session.reason,
      // For reason "shop", print both sides of the comparison so the fix is
      // obvious from one line: what the token claimed and what we accept.
      ...(session.reason === "shop"
        ? {
            tokenDest: session.dest ?? null,
            tokenDestHost: session.destHost ?? null,
            expectedShopDomain: session.expected ?? null,
            expectedAltDomains: session.expectedAlt ?? [],
          }
        : {}),
    });
    return json({ error: "unauthorized", reason: session.reason }, { status: 401, cors: true });
  }

  const body = await readJsonBody(request);
  const rawOrderId = body?.orderId;
  if (rawOrderId === undefined || rawOrderId === null || rawOrderId === "") {
    log.warn("status.bad_request", { reason: "missing_order_id" });
    return json(
      { error: "bad_request", message: `orderId is required: ${OrderIdError.expected}.` },
      { status: 400, cors: true },
    );
  }
  let orderId: string;
  try {
    orderId = normalizeOrderId(String(rawOrderId));
  } catch (error) {
    const received =
      error instanceof OrderIdError ? error.received : String(rawOrderId).slice(0, 120);
    log.warn("status.bad_request", { reason: "unrecognised_order_id", received });
    return json(
      {
        error: "bad_request",
        message: `orderId is not a recognised order identifier. Received ${JSON.stringify(received)}, expected ${OrderIdError.expected}.`,
      },
      { status: 400, cors: true },
    );
  }

  return logged("api.spin.status", orderId, async () => {
    try {
      const status = await getSpinStatus(orderId, { admin: getAdminClient(), env });
      return json(status, { cors: true });
    } catch (error) {
      if (error instanceof SpinError)
        return json(error.toJSON(), { status: error.status, cors: true });
      log.error("status.failed", { orderId, error });
      return json({ error: "internal", retryable: true }, { status: 500, cors: true });
    }
  });
}
