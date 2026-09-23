/**
 * Shared guard for the app proxy routes: verifies Shopify's proxy signature
 * and the signed spin token, returning the order ID or an error Response.
 */
import type { AppEnv } from "~/config/env.server";
import { json } from "~/lib/http.server";
import { log } from "~/lib/log.server";
import { verifyAppProxyRequest } from "~/lib/proxy.server";
import { verifySpinToken } from "~/lib/spin-token.server";

export type ProxyGuard = { ok: true; orderId: string } | { ok: false; response: Response };

export function guardProxyRequest(
  request: Request,
  token: string | null | undefined,
  env: AppEnv,
): ProxyGuard {
  const url = new URL(request.url);
  const proxy = verifyAppProxyRequest(url, env.shopifyApiSecret, { shopDomain: env.shopDomain });
  if (!proxy.ok) {
    log.warn("proxy.rejected", { reason: proxy.reason, path: url.pathname });
    return {
      ok: false,
      response: json({ error: "forbidden", reason: proxy.reason }, { status: 403 }),
    };
  }
  const spin = verifySpinToken(env.spinSecret, token);
  if (!spin.ok) {
    log.warn("proxy.invalid_token", { reason: spin.reason, path: url.pathname });
    return {
      ok: false,
      response: json({ error: "invalid_token", reason: spin.reason }, { status: 401 }),
    };
  }
  return { ok: true, orderId: spin.orderId };
}
