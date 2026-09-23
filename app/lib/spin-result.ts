/**
 * The order metafield record (`greentee_spin.result`, type json).
 *
 * Deviations from the example in CLAUDE.md, per later decisions:
 * - No `notified` field: the code is delivered on screen and nowhere else.
 * - Gifts carry a `gift` object describing the issued line, not a claim
 *   reference. `code` is null for gifts.
 * - `testMode` and `forced` are recorded for test users.
 */
import { SPIN_RESULT_VERSION, type RewardKey } from "~/config/campaign";

export interface GiftIssuance {
  /** The product variant added to the order at no charge. */
  readonly variantId: string;
  /** Line item created by the order edit, once known. */
  readonly lineItemId: string | null;
  /** The committed OrderEdit, for audit. */
  readonly orderEditId: string | null;
  /** Stable handle for idempotent re-issue checks (derived, not random). */
  readonly reference: string;
}

export interface SpinResultRecord {
  readonly version: typeof SPIN_RESULT_VERSION;
  readonly spunAt: string;
  readonly sliceIndex: number;
  readonly rewardKey: RewardKey;
  readonly rewardLabel: string;
  readonly rewardType: "discount" | "gift";
  /** Discount code for discount rewards; null for gifts. */
  readonly code: string | null;
  readonly discountNodeId: string | null;
  readonly gift: GiftIssuance | null;
  /** Campaign end, when discount codes stop working. */
  readonly expiresAt: string;
  readonly email: string | null;
  readonly testMode: boolean;
  readonly forced: boolean;
}

export class SpinResultParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SpinResultParseError";
  }
}

function isIsoDate(v: unknown): v is string {
  return typeof v === "string" && !Number.isNaN(Date.parse(v));
}

/**
 * Parses the raw metafield value. Returns null when there is no value, the
 * record when it is well formed, and throws when the value is present but
 * malformed (a corrupt record must never be mistaken for "not spun yet").
 */
export function parseSpinResult(raw: string | null | undefined): SpinResultRecord | null {
  if (raw === null || raw === undefined || raw.trim() === "") return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new SpinResultParseError("spin result metafield is not valid JSON");
  }
  if (!value || typeof value !== "object")
    throw new SpinResultParseError("spin result is not an object");
  const r = value as Record<string, unknown>;
  const problems: string[] = [];
  if (r.version !== SPIN_RESULT_VERSION) problems.push(`unsupported version ${String(r.version)}`);
  if (!isIsoDate(r.spunAt)) problems.push("spunAt missing");
  if (!Number.isInteger(r.sliceIndex)) problems.push("sliceIndex missing");
  if (typeof r.rewardKey !== "string") problems.push("rewardKey missing");
  if (typeof r.rewardLabel !== "string") problems.push("rewardLabel missing");
  if (r.rewardType !== "discount" && r.rewardType !== "gift") problems.push("rewardType invalid");
  if (!isIsoDate(r.expiresAt)) problems.push("expiresAt missing");
  if (problems.length)
    throw new SpinResultParseError(`spin result malformed: ${problems.join(", ")}`);
  return {
    version: SPIN_RESULT_VERSION,
    spunAt: r.spunAt as string,
    sliceIndex: r.sliceIndex as number,
    rewardKey: r.rewardKey as RewardKey,
    rewardLabel: r.rewardLabel as string,
    rewardType: r.rewardType as "discount" | "gift",
    code: typeof r.code === "string" ? r.code : null,
    discountNodeId: typeof r.discountNodeId === "string" ? r.discountNodeId : null,
    gift: r.gift && typeof r.gift === "object" ? (r.gift as GiftIssuance) : null,
    expiresAt: r.expiresAt as string,
    email: typeof r.email === "string" ? r.email : null,
    testMode: r.testMode === true,
    forced: r.forced === true,
  };
}

/** What the customer-facing endpoints expose. Never includes email. */
export interface PublicSpinResult {
  readonly sliceIndex: number;
  readonly rewardKey: RewardKey;
  readonly rewardLabel: string;
  readonly rewardType: "discount" | "gift";
  readonly code: string | null;
  readonly gift: { readonly variantId: string; readonly reference: string } | null;
  readonly spunAt: string;
  readonly expiresAt: string;
  readonly expired: boolean;
  readonly testMode: boolean;
}

export function toPublicResult(record: SpinResultRecord, now: Date): PublicSpinResult {
  return {
    sliceIndex: record.sliceIndex,
    rewardKey: record.rewardKey,
    rewardLabel: record.rewardLabel,
    rewardType: record.rewardType,
    code: record.code,
    gift: record.gift
      ? { variantId: record.gift.variantId, reference: record.gift.reference }
      : null,
    spunAt: record.spunAt,
    expiresAt: record.expiresAt,
    expired: now.getTime() >= Date.parse(record.expiresAt),
    testMode: record.testMode,
  };
}
