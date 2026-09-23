import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { computeProxySignature, verifyAppProxyRequest } from "./proxy.server";

const SECRET = "hush";
const SHOP = "greentee.myshopify.com";
const TS = 1317327555;
const NOW = new Date(TS * 1000);

/**
 * Independent implementation of the documented algorithm, written the way
 * Shopify's Ruby example does it: `key=v1,v2` strings, sorted, concatenated.
 * (The hex digests printed in the docs were produced with a real shop name
 * that was later replaced by a `{shop}` placeholder, so they cannot be used
 * as known answers.)
 */
function referenceSignature(params: Record<string, string | string[]>): string {
  const message = Object.entries(params)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`)
    .sort()
    .join("");
  return createHmac("sha256", SECRET).update(message).digest("hex");
}

function signedUrl(params: Record<string, string | string[]>, secret = SECRET): URL {
  const url = new URL("https://app.example.com/apps/spin/state");
  for (const [k, v] of Object.entries(params)) {
    for (const value of Array.isArray(v) ? v : [v]) url.searchParams.append(k, value);
  }
  const message = Object.entries(params)
    .map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(",") : v}`)
    .sort()
    .join("");
  url.searchParams.set("signature", createHmac("sha256", secret).update(message).digest("hex"));
  return url;
}

const BASE = {
  shop: SHOP,
  path_prefix: "/apps/spin",
  timestamp: String(TS),
  logged_in_customer_id: "",
  token: "v1.abc.def",
};

describe("computeProxySignature", () => {
  it("matches the documented algorithm, including multi-value params and decoding", () => {
    const params = { ...BASE, extra: ["1", "2"] };
    const url = signedUrl(params);
    expect(computeProxySignature(url.searchParams, SECRET)).toBe(referenceSignature(params));
  });

  it("ignores the signature parameter itself", () => {
    const withSig = new URLSearchParams({ ...BASE, signature: "deadbeef" });
    const without = new URLSearchParams(BASE);
    expect(computeProxySignature(withSig, SECRET)).toBe(computeProxySignature(without, SECRET));
  });
});

describe("verifyAppProxyRequest", () => {
  const opts = { shopDomain: SHOP, now: NOW };

  it("accepts a valid request and exposes the parameters", () => {
    const url = signedUrl({ ...BASE, logged_in_customer_id: "42" });
    expect(verifyAppProxyRequest(url, SECRET, opts)).toEqual({
      ok: true,
      params: { shop: SHOP, pathPrefix: "/apps/spin", timestamp: TS, loggedInCustomerId: "42" },
    });
  });

  it("treats an empty logged_in_customer_id as anonymous", () => {
    const result = verifyAppProxyRequest(signedUrl(BASE), SECRET, opts);
    expect(result.ok).toBe(true);
    expect(result.ok && result.params.loggedInCustomerId).toBeNull();
  });

  it("rejects a tampered parameter and a wrong secret", () => {
    const url = signedUrl(BASE);
    url.searchParams.set("token", "v1.forged.def");
    expect(verifyAppProxyRequest(url, SECRET, opts)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(verifyAppProxyRequest(signedUrl(BASE, "other"), SECRET, opts)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a missing signature", () => {
    const url = signedUrl(BASE);
    url.searchParams.delete("signature");
    expect(verifyAppProxyRequest(url, SECRET, opts)).toEqual({
      ok: false,
      reason: "missing_signature",
    });
  });

  it("rejects a correctly signed request for a different shop", () => {
    const url = signedUrl({ ...BASE, shop: "other.myshopify.com" });
    expect(verifyAppProxyRequest(url, SECRET, opts)).toEqual({ ok: false, reason: "wrong_shop" });
  });

  it("rejects a stale timestamp", () => {
    const url = signedUrl(BASE);
    expect(
      verifyAppProxyRequest(url, SECRET, { ...opts, now: new Date(NOW.getTime() + 3600_000) }),
    ).toEqual({
      ok: false,
      reason: "stale",
    });
  });
});
