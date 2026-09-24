import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bearerToken, verifySessionToken } from "./session-token.server";

const SECRET = "app-secret";
const KEY = "app-key";
const SHOP = "greentee.myshopify.com";
const NOW = new Date("2026-10-05T12:00:00Z");
const nowSec = Math.floor(NOW.getTime() / 1000);

function jwt(claims: Record<string, unknown>, secret = SECRET, alg = "HS256"): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = enc({ alg, typ: "JWT" });
  const p = enc(claims);
  const sig = createHmac("sha256", secret).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}

const good = {
  iss: `https://${SHOP}/admin`,
  dest: `https://${SHOP}`,
  aud: KEY,
  sub: "gid://shopify/Customer/1",
  exp: nowSec + 60,
  nbf: nowSec - 5,
  iat: nowSec - 5,
  jti: "x",
};
const opts = { apiSecret: SECRET, apiKey: KEY, shopDomain: SHOP, now: NOW };

describe("verifySessionToken", () => {
  it("accepts a valid token", () => {
    const r = verifySessionToken(jwt(good), opts);
    expect(r.ok).toBe(true);
    expect(r.ok && r.claims.sub).toBe("gid://shopify/Customer/1");
  });

  it("rejects bad signature, algorithm and shape", () => {
    expect(verifySessionToken(jwt(good, "wrong"), opts)).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(verifySessionToken(jwt(good, SECRET, "none"), opts)).toEqual({
      ok: false,
      reason: "algorithm",
    });
    expect(verifySessionToken("a.b", opts)).toEqual({ ok: false, reason: "malformed" });
    expect(verifySessionToken(null, opts)).toEqual({ ok: false, reason: "malformed" });
  });

  it("rejects expired, not-yet-valid, wrong audience and wrong shop", () => {
    expect(verifySessionToken(jwt({ ...good, exp: nowSec - 120 }), opts)).toEqual({
      ok: false,
      reason: "expired",
    });
    expect(verifySessionToken(jwt({ ...good, nbf: nowSec + 120 }), opts)).toEqual({
      ok: false,
      reason: "not_yet_valid",
    });
    expect(verifySessionToken(jwt({ ...good, aud: "other" }), opts)).toEqual({
      ok: false,
      reason: "audience",
    });
    expect(verifySessionToken(jwt({ ...good, dest: "https://evil.myshopify.com" }), opts)).toEqual({
      ok: false,
      reason: "shop",
      dest: "https://evil.myshopify.com",
      destHost: "evil.myshopify.com",
      expected: SHOP,
      expectedAlt: [],
    });
  });

  it("accepts a bare-host dest claim, with or without a scheme", () => {
    // Shopify does not guarantee a scheme on `dest`. Parsing it with `new URL()`
    // alone threw, which rejected every token from that surface.
    expect(verifySessionToken(jwt({ ...good, dest: SHOP }), opts).ok).toBe(true);
    expect(verifySessionToken(jwt({ ...good, dest: `${SHOP}/` }), opts).ok).toBe(true);
    expect(
      verifySessionToken(jwt({ ...good, dest: `HTTPS://${SHOP.toUpperCase()}/` }), opts).ok,
    ).toBe(true);
  });

  it("accepts an allow-listed alternate shop host from SHOP_ALT_DOMAINS", () => {
    const alt = { ...opts, altDomains: new Set(["shop.greenteegolfshop.com"]) };
    expect(verifySessionToken(jwt({ ...good, dest: "shop.greenteegolfshop.com" }), alt).ok).toBe(
      true,
    );
    expect(
      verifySessionToken(jwt({ ...good, dest: "https://shop.greenteegolfshop.com/" }), alt).ok,
    ).toBe(true);
    expect(verifySessionToken(jwt({ ...good, dest: "other.example" }), alt)).toMatchObject({
      ok: false,
      reason: "shop",
      destHost: "other.example",
      expectedAlt: ["shop.greenteegolfshop.com"],
    });
  });

  it("reports a missing or unparseable dest instead of hiding it", () => {
    const { dest: _omit, ...noDest } = good;
    expect(verifySessionToken(jwt(noDest), opts)).toMatchObject({
      ok: false,
      reason: "shop",
      dest: null,
      destHost: null,
      expected: SHOP,
    });
  });

  it("allows small clock skew", () => {
    expect(verifySessionToken(jwt({ ...good, exp: nowSec - 30 }), opts).ok).toBe(true);
  });
});

describe("bearerToken", () => {
  it("extracts the token", () => {
    expect(bearerToken("Bearer abc.def.ghi")).toBe("abc.def.ghi");
    expect(bearerToken("bearer x")).toBe("x");
    expect(bearerToken("Basic x")).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});
