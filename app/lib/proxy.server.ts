/**
 * App proxy request verification, per
 * https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies
 *
 * Shopify appends `shop`, `path_prefix`, `timestamp`, `logged_in_customer_id`
 * and `signature` to the proxied query string. The signature is the hex
 * HMAC-SHA256 (keyed by the app secret) of every other parameter rendered as
 * `key=value` (multi-values joined by commas), sorted, and concatenated with
 * no separator.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

export interface ProxyParams {
  readonly shop: string;
  readonly pathPrefix: string;
  readonly timestamp: number;
  readonly loggedInCustomerId: string | null;
}

export type ProxyVerification =
  | { ok: true; params: ProxyParams }
  | { ok: false; reason: "missing_signature" | "bad_signature" | "wrong_shop" | "stale" };

export interface ProxyVerifyOptions {
  /** Expected *.myshopify.com domain. */
  readonly shopDomain: string;
  /** Reject timestamps older than this many seconds. Default 15 minutes. */
  readonly maxAgeSeconds?: number;
  readonly now?: Date;
}

export function computeProxySignature(searchParams: URLSearchParams, secret: string): string {
  const grouped = new Map<string, string[]>();
  for (const [key, value] of searchParams) {
    if (key === "signature") continue;
    const list = grouped.get(key) ?? [];
    list.push(value);
    grouped.set(key, list);
  }
  const message = [...grouped.entries()]
    .map(([k, values]) => `${k}=${values.join(",")}`)
    .sort()
    .join("");
  return createHmac("sha256", secret).update(message).digest("hex");
}

export function verifyAppProxyRequest(
  url: URL,
  secret: string,
  opts: ProxyVerifyOptions,
): ProxyVerification {
  const provided = url.searchParams.get("signature");
  if (!provided) return { ok: false, reason: "missing_signature" };
  const expected = computeProxySignature(url.searchParams, secret);
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b))
    return { ok: false, reason: "bad_signature" };

  const shop = (url.searchParams.get("shop") ?? "").toLowerCase();
  if (shop !== opts.shopDomain.toLowerCase()) return { ok: false, reason: "wrong_shop" };

  const timestamp = Number(url.searchParams.get("timestamp"));
  const maxAge = opts.maxAgeSeconds ?? 15 * 60;
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (!Number.isFinite(timestamp) || Math.abs(nowSeconds - timestamp) > maxAge) {
    return { ok: false, reason: "stale" };
  }

  const customer = url.searchParams.get("logged_in_customer_id");
  return {
    ok: true,
    params: {
      shop,
      pathPrefix: url.searchParams.get("path_prefix") ?? "",
      timestamp,
      loggedInCustomerId: customer && customer !== "" ? customer : null,
    },
  };
}
