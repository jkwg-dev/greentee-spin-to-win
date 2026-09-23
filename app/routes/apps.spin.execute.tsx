/**
 * POST /apps/spin/execute   { token, forceSlice? }   (via the Shopify app proxy)
 *
 * Performs the spin for the order in the token. `forceSlice` is honoured for
 * test users only; anyone else gets a 403.
 */
import type { ActionFunctionArgs } from "react-router";
import { getEnv } from "~/config/env.server";
import { getAdminClient } from "~/lib/admin.server";
import { json, methodNotAllowed, readJsonBody } from "~/lib/http.server";
import { log } from "~/lib/log.server";
import { guardProxyRequest } from "~/lib/proxy-route.server";
import { SpinError, executeSpin } from "~/lib/spin.server";

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

  try {
    const outcome = await executeSpin(
      guard.orderId,
      { forceSlice: body?.forceSlice },
      { admin: getAdminClient(), env },
    );
    return json(outcome);
  } catch (error) {
    if (error instanceof SpinError) return json(error.toJSON(), { status: error.status });
    log.error("execute.failed", { orderId: guard.orderId, error });
    return json({ error: "internal", retryable: true }, { status: 500 });
  }
}
