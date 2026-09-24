/**
 * Deterministic outcome derivation.
 *
 * Everything here is a pure function of (SPIN_SECRET, order ID). Two racing
 * requests for the same order therefore compute the identical slice, the
 * identical discount code and the identical gift reference. See CLAUDE.md,
 * "Idempotency: the important part".
 *
 * One deliberate deviation from the prose in CLAUDE.md: the 32-bit roll is
 * divided by 2^32, not 0xFFFFFFFF. Dividing by 0xFFFFFFFF makes the range
 * closed at 1.0, and a roll of exactly 1.0 would match no slice. Dividing by
 * 2^32 gives the half-open [0, 1) that the cumulative table needs.
 */
import { createHmac } from "node:crypto";
import { CODE_FORMAT, SLICES, type Slice } from "~/config/campaign";

const ROLL_DIVISOR = 0x1_0000_0000; // 2^32

/** Byte layout of the 32-byte HMAC digest. */
const ROLL_BYTES = { start: 0, end: 4 } as const;
const CODE_BYTES = { start: 4, end: 4 + CODE_FORMAT.discountLength } as const;
const GIFT_BYTES = { start: CODE_BYTES.end, end: CODE_BYTES.end + CODE_FORMAT.giftLength } as const;

/**
 * Order identifiers arrive in three shapes and must all reduce to the same
 * numeric ID, because the outcome HMAC is computed over it:
 *
 * - `gid://shopify/Order/<id>` from the order status target
 * - `gid://shopify/OrderIdentity/<id>` from the thank you target. Its own
 *   typings claim `gid://shopify/Order/...`, which is wrong; the docs note
 *   the value "becomes the Order object ID in the Admin API", so the numeric
 *   suffix is the order's ID and only the type prefix differs.
 * - a bare numeric ID, used by scripts and tests
 *
 * Any other shape is rejected rather than guessed at.
 */
const ORDER_GID = /^gid:\/\/shopify\/(?:Order|OrderIdentity)\/(\d+)$/;

/** Thrown when an order identifier is not one of the accepted shapes. */
export class OrderIdError extends Error {
  /** What arrived, truncated, so it is safe to put in a response or a log. */
  readonly received: string;
  static readonly expected =
    "a numeric order ID, gid://shopify/Order/<id>, or gid://shopify/OrderIdentity/<id>";
  constructor(received: string) {
    const shown = received.length > 120 ? `${received.slice(0, 120)}...` : received;
    super(`Unrecognised order id ${JSON.stringify(shown)}. Expected ${OrderIdError.expected}.`);
    this.name = "OrderIdError";
    this.received = shown;
  }
}

/**
 * Normalises an order identifier to its numeric string form so that a GID
 * and a bare numeric ID derive the same outcome.
 */
export function normalizeOrderId(orderId: string | number): string {
  const raw = String(orderId).trim();
  const gid = ORDER_GID.exec(raw);
  if (gid) return gid[1];
  if (/^\d+$/.test(raw)) return raw;
  throw new OrderIdError(raw);
}

export function orderGid(orderId: string | number): string {
  return `gid://shopify/Order/${normalizeOrderId(orderId)}`;
}

/** hmacSha256(SPIN_SECRET, String(orderId)) as raw bytes. */
export function outcomeDigest(secret: string, orderId: string | number): Buffer {
  if (!secret) throw new Error("SPIN_SECRET is required to derive an outcome");
  return createHmac("sha256", secret).update(normalizeOrderId(orderId)).digest();
}

/** First 8 hex characters of the digest as an unsigned 32-bit integer, mapped onto [0, 1). */
export function rollFromDigest(digest: Buffer): number {
  return digest.readUInt32BE(ROLL_BYTES.start) / ROLL_DIVISOR;
}

/** Convenience for tests and tooling: accepts the hex form of the digest. */
export function rollFromHex(hex: string): number {
  if (!/^[0-9a-f]{8,}$/i.test(hex)) throw new Error("expected at least 8 hex characters");
  return parseInt(hex.slice(0, 8), 16) / ROLL_DIVISOR;
}

/**
 * Maps a roll in [0, 1) onto the cumulative probability table. The first slice
 * whose cumulative probability strictly exceeds the roll wins. Because the
 * table sums to 100 and the roll is strictly below 1, the last slice's upper
 * bound is never reached from above and nothing outside the table can win.
 */
export function selectSlice(roll: number, slices: readonly Slice[] = SLICES): Slice {
  if (!(roll >= 0 && roll < 1)) throw new Error(`roll out of range: ${roll}`);
  // Accumulate in integer percentages and divide once per comparison, so the
  // boundaries are exactly the correctly rounded values of 25/100, 29/100, ...
  // Summing floats incrementally would put slice boundaries a few ULPs off.
  let cumulative = 0;
  for (const slice of slices) {
    cumulative += slice.probability;
    if (roll < cumulative / 100) return slice;
  }
  // Unreachable while the table sums to 100. Guard anyway.
  throw new Error("roll did not map to any slice; reward table is inconsistent");
}

function charsFrom(digest: Buffer, start: number, end: number): string {
  const { alphabet } = CODE_FORMAT;
  let out = "";
  for (let i = start; i < end; i++) {
    // alphabet has 32 entries and 256 % 32 === 0, so this pick is uniform.
    out += alphabet[digest[i] % alphabet.length];
  }
  return out;
}

export interface DerivedOutcome {
  readonly roll: number;
  readonly slice: Slice;
  /** XXXXXXXX (or TEST-XXXXXXXX). Only meaningful for discount slices. */
  readonly discountCode: string;
  /** GFJ-XXXXXX. Only meaningful for gift slices. */
  readonly giftReference: string;
}

export interface DeriveOptions {
  /** Test-user spins carry the TEST- prefix so they can be bulk deleted later. */
  readonly testMode?: boolean;
}

/** Derives the code suffix only, without the prefix. */
export function deriveCodeSuffix(digest: Buffer): string {
  return charsFrom(digest, CODE_BYTES.start, CODE_BYTES.end);
}

export function deriveDiscountCode(digest: Buffer, opts: DeriveOptions = {}): string {
  const prefix = opts.testMode ? CODE_FORMAT.testDiscountPrefix : CODE_FORMAT.discountPrefix;
  return prefix + deriveCodeSuffix(digest);
}

export function deriveGiftReference(digest: Buffer): string {
  return CODE_FORMAT.giftPrefix + charsFrom(digest, GIFT_BYTES.start, GIFT_BYTES.end);
}

/** The whole derived outcome for an order. */
export function deriveOutcome(
  secret: string,
  orderId: string | number,
  opts: DeriveOptions = {},
): DerivedOutcome {
  const digest = outcomeDigest(secret, orderId);
  const roll = rollFromDigest(digest);
  return {
    roll,
    slice: selectSlice(roll),
    discountCode: deriveDiscountCode(digest, opts),
    giftReference: deriveGiftReference(digest),
  };
}

export class ForceSliceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForceSliceError";
  }
}

/**
 * Validates a `forceSlice` value supplied by a test user: an integer index of
 * a slice in the table (1 to SLICES.length). Authorisation (is this a test
 * user?) is the caller's job.
 */
export function resolveForcedSlice(input: unknown, slices: readonly Slice[] = SLICES): Slice {
  const n = typeof input === "string" && input.trim() !== "" ? Number(input) : input;
  if (typeof n !== "number" || !Number.isInteger(n)) {
    throw new ForceSliceError(`forceSlice must be an integer between 1 and ${slices.length}`);
  }
  const slice = slices.find((s) => s.index === n);
  if (!slice || slice.probability === 0) {
    throw new ForceSliceError(`slice ${String(input)} is not a valid outcome`);
  }
  return slice;
}
