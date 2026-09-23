/**
 * Signed spin URL token. Carries the order ID and an expiry; nothing else.
 * Format: `v1.<base64url payload>.<base64url HMAC-SHA256>`.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeOrderId } from "~/lib/outcome";

const VERSION = "v1";

interface Payload {
  /** Numeric order ID as a string. */
  o: string;
  /** Expiry, unix seconds. */
  exp: number;
  /** Issued at, unix seconds. */
  iat: number;
}

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function sign(secret: string, signingInput: string): Buffer {
  return createHmac("sha256", secret).update(signingInput).digest();
}

export function createSpinToken(
  secret: string,
  orderId: string | number,
  ttlSeconds: number,
  now: Date = new Date(),
): string {
  if (!secret) throw new Error("SPIN_SECRET is required to sign tokens");
  const iat = Math.floor(now.getTime() / 1000);
  const payload: Payload = { o: normalizeOrderId(orderId), exp: iat + ttlSeconds, iat };
  const encoded = b64url(Buffer.from(JSON.stringify(payload)));
  const signingInput = `${VERSION}.${encoded}`;
  return `${signingInput}.${b64url(sign(secret, signingInput))}`;
}

export type SpinTokenResult =
  | { ok: true; orderId: string; expiresAt: Date }
  | { ok: false; reason: "malformed" | "signature" | "expired" };

export function verifySpinToken(
  secret: string,
  token: string | null | undefined,
  now: Date = new Date(),
): SpinTokenResult {
  if (!token || typeof token !== "string") return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== VERSION) return { ok: false, reason: "malformed" };
  const [, encoded, sig] = parts;
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const expected = sign(secret, `${VERSION}.${encoded}`);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "signature" };
  }
  let payload: Payload;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Payload;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof payload.o !== "string" || !/^\d+$/.test(payload.o) || !Number.isFinite(payload.exp)) {
    return { ok: false, reason: "malformed" };
  }
  if (Math.floor(now.getTime() / 1000) >= payload.exp) return { ok: false, reason: "expired" };
  return { ok: true, orderId: payload.o, expiresAt: new Date(payload.exp * 1000) };
}
