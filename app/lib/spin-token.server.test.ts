import { describe, expect, it } from "vitest";
import { createSpinToken, verifySpinToken } from "./spin-token.server";

const SECRET = "spin-secret-for-tests-0123456789";
const NOW = new Date("2026-10-05T12:00:00Z");

describe("spin token", () => {
  it("round-trips the order id and expiry", () => {
    const token = createSpinToken(SECRET, "gid://shopify/Order/123", 3600, NOW);
    const result = verifySpinToken(SECRET, token, NOW);
    expect(result).toEqual({
      ok: true,
      orderId: "123",
      expiresAt: new Date("2026-10-05T13:00:00Z"),
    });
  });

  it("rejects a tampered payload", () => {
    const token = createSpinToken(SECRET, 123, 3600, NOW);
    const [v, payload, sig] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ o: "124", exp: 9999999999, iat: 0 })).toString(
      "base64url",
    );
    expect(verifySpinToken(SECRET, `${v}.${forged}.${sig}`, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
    expect(verifySpinToken("other-secret", `${v}.${payload}.${sig}`, NOW)).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("rejects expired tokens", () => {
    const token = createSpinToken(SECRET, 123, 60, NOW);
    expect(verifySpinToken(SECRET, token, new Date(NOW.getTime() + 61_000))).toEqual({
      ok: false,
      reason: "expired",
    });
  });

  it("rejects malformed input", () => {
    for (const bad of [null, undefined, "", "v1", "v2.a.b", "v1.a", "nope.nope.nope"]) {
      expect(verifySpinToken(SECRET, bad, NOW).ok).toBe(false);
    }
  });
});
