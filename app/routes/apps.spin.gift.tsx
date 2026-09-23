/**
 * POST /apps/spin/gift   { token, selection?: { Size: "22" } }   (via the Shopify app proxy)
 *
 * Adds the won gift to the order through the Order Editing API.
 */
import type { ActionFunctionArgs } from "react-router";
import { getEnv } from "~/config/env.server";
import { getAdminClient } from "~/lib/admin.server";
import { json, methodNotAllowed, readJsonBody } from "~/lib/http.server";
import { log } from "~/lib/log.server";
import { guardProxyRequest } from "~/lib/proxy-route.server";
import { logged } from "~/lib/request-log.server";
import { SpinError, confirmGift } from "~/lib/spin.server";

export function loader() {
  return methodNotAllowed("POST");
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") return methodNotAllowed("POST");
  const env = getEnv();
  const body = await readJsonBody(request);
  const token =
    typeof body?.token === "string" ? body.token : new URL(request.url).searchParams.get("token");
  const guard = guardProxyRequest(request, token, env);
  if (!guard.ok) return guard.response;

  const raw = body?.selection;
  const selection =
    raw && typeof raw === "object"
      ? Object.fromEntries(
          Object.entries(raw as Record<string, unknown>)
            .filter(([, v]) => typeof v === "string")
            .map(([k, v]) => [k, String(v).slice(0, 40)]),
        )
      : null;

  return logged("apps.spin.gift", guard.orderId, async () => {
    try {
      return json(
        await confirmGift(guard.orderId, { selection }, { admin: getAdminClient(), env }),
      );
    } catch (error) {
      if (error instanceof SpinError) return json(error.toJSON(), { status: error.status });
      log.error("gift.failed", { orderId: guard.orderId, error });
      return json({ error: "internal", retryable: true }, { status: 500 });
    }
  });
}
