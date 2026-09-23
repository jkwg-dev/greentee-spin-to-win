/**
 * GET /apps/spin/state?token=...   (via the Shopify app proxy)
 *
 * Returns the current state for the spin page: closed, pending, eligible,
 * ineligible, or the stored result, plus the wheel labels.
 */
import type { LoaderFunctionArgs } from "react-router";
import { getEnv } from "~/config/env.server";
import { getAdminClient } from "~/lib/admin.server";
import { json } from "~/lib/http.server";
import { log } from "~/lib/log.server";
import { guardProxyRequest } from "~/lib/proxy-route.server";
import { SpinError, getSpinState } from "~/lib/spin.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const env = getEnv();
  const guard = guardProxyRequest(request, new URL(request.url).searchParams.get("token"), env);
  if (!guard.ok) return guard.response;

  try {
    return json(await getSpinState(guard.orderId, { admin: getAdminClient(), env }));
  } catch (error) {
    if (error instanceof SpinError) return json(error.toJSON(), { status: error.status });
    log.error("state.failed", { orderId: guard.orderId, error });
    return json({ error: "internal", retryable: true }, { status: 500 });
  }
}
