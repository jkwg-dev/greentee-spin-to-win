/**
 * Verifies the session token a checkout UI extension obtains via
 * `shopify.sessionToken.get()`. It is an HS256 JWT signed with the app
 * secret. We check the signature, the time window, the audience (our client
 * ID) and the destination shop.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { normalizeHost } from "~/lib/host";

export interface SessionTokenClaims {
  readonly iss?: string;
  readonly dest?: string;
  readonly aud?: string;
  readonly sub?: string;
  readonly exp?: number;
  readonly nbf?: number;
  readonly iat?: number;
  readonly jti?: string;
  readonly sid?: string;
  readonly [k: string]: unknown;
}

export type SessionTokenFailureReason =
  "malformed" | "algorithm" | "signature" | "expired" | "not_yet_valid" | "audience" | "shop";

export type SessionTokenResult =
  | { ok: true; claims: SessionTokenClaims }
  | {
      ok: false;
      reason: SessionTokenFailureReason;
      /** Raw `dest` claim, for reason "shop". Null when the claim is absent. */
      dest?: string | null;
      /** `dest` reduced to a hostname, for reason "shop". Null when unparseable. */
      destHost?: string | null;
      /** The host we expected, for reason "shop". */
      expected?: string;
      /** Additional accepted hosts from SHOP_ALT_DOMAINS, for reason "shop". */
      expectedAlt?: readonly string[];
    };

export interface SessionTokenOptions {
  readonly apiSecret: string;
  readonly apiKey: string;
  readonly shopDomain: string;
  /** Additional accepted `dest` hosts (lower-cased). */
  readonly altDomains?: ReadonlySet<string>;
  readonly now?: Date;
  /** Clock skew allowance in seconds. Default 60. */
  readonly leewaySeconds?: number;
}

function decodeSegment(seg: string): unknown {
  return JSON.parse(Buffer.from(seg, "base64url").toString("utf8"));
}

export function verifySessionToken(
  token: string | null | undefined,
  opts: SessionTokenOptions,
): SessionTokenResult {
  if (!token || typeof token !== "string") return { ok: false, reason: "malformed" };
  const parts = token.split(".");
  if (parts.length !== 3) return { ok: false, reason: "malformed" };
  const [h, p, s] = parts;

  let header: { alg?: string; typ?: string };
  let claims: SessionTokenClaims;
  try {
    header = decodeSegment(h) as { alg?: string };
    claims = decodeSegment(p) as SessionTokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (header.alg !== "HS256") return { ok: false, reason: "algorithm" };

  const expected = createHmac("sha256", opts.apiSecret).update(`${h}.${p}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(s, "base64url");
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: "signature" };
  }

  const now = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  const leeway = opts.leewaySeconds ?? 60;
  if (typeof claims.exp !== "number" || now >= claims.exp + leeway)
    return { ok: false, reason: "expired" };
  if (typeof claims.nbf === "number" && now + leeway < claims.nbf)
    return { ok: false, reason: "not_yet_valid" };
  if (claims.aud !== opts.apiKey) return { ok: false, reason: "audience" };

  // `dest` may be a full URL or a bare host depending on the surface, so it is
  // normalised rather than passed straight to `new URL()`.
  const expectedHost = normalizeHost(opts.shopDomain) ?? opts.shopDomain.toLowerCase();
  const destHost = normalizeHost(claims.dest);
  const alt = opts.altDomains ?? new Set<string>();
  const accepted = destHost !== null && (destHost === expectedHost || alt.has(destHost));
  if (!accepted) {
    return {
      ok: false,
      reason: "shop",
      dest: typeof claims.dest === "string" ? claims.dest : null,
      destHost,
      expected: expectedHost,
      expectedAlt: [...alt],
    };
  }

  return { ok: true, claims };
}

/** Extracts a Bearer token from an Authorization header. */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : null;
}
