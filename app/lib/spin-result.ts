/**
 * The order metafield record (`greentee_spin.result`, type json).
 *
 * Deviations from the example in CLAUDE.md, per later decisions:
 * - No `notified` field: the code is delivered on screen and nowhere else.
 * - Gifts carry a `gift` object tracking the Order Editing flow (pending,
 *   added, unavailable), not a claim reference. `code` is null for gifts.
 * - `testMode` and `forced` are recorded for test users.
 */
import { SPIN_RESULT_VERSION, type RewardKey } from "~/config/campaign";

export type GiftStatus = "pending" | "added" | "unavailable";

/**
 * Gift progress on the order.
 * - pending: won, recorded, order tagged gift-pending; the customer has not confirmed yet.
 * - added: the variant is on the order at 100% off; order tagged gift-added.
 * - unavailable: nothing in stock when the customer confirmed; tag stays gift-pending
 *   and staff handle it manually. `reason` says why.
 */
export interface GiftRecord {
  readonly status: GiftStatus;
  readonly productId: string;
  readonly variantId: string | null;
  readonly variantTitle: string | null;
  readonly lineItemId: string | null;
  readonly orderEditId: string | null;
  /** Derived, stable per order. Recorded in the staff note of the order edit. */
  readonly reference: string;
  /** What the customer chose, e.g. { "Size": "22" }. */
  readonly selection: Readonly<Record<string, string>> | null;
  readonly reason: string | null;
  readonly updatedAt: string;
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
  readonly gift: GiftRecord | null;
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
    gift: parseGift(r.gift),
    expiresAt: r.expiresAt as string,
    email: typeof r.email === "string" ? r.email : null,
    testMode: r.testMode === true,
    forced: r.forced === true,
  };
}

function parseGift(raw: unknown): GiftRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  const status = g.status;
  if (status !== "pending" && status !== "added" && status !== "unavailable") {
    throw new SpinResultParseError("gift status invalid");
  }
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  return {
    status,
    productId: str(g.productId) ?? "",
    variantId: str(g.variantId),
    variantTitle: str(g.variantTitle),
    lineItemId: str(g.lineItemId),
    orderEditId: str(g.orderEditId),
    reference: str(g.reference) ?? "",
    selection:
      g.selection && typeof g.selection === "object"
        ? (g.selection as Record<string, string>)
        : null,
    reason: str(g.reason),
    updatedAt: str(g.updatedAt) ?? "",
  };
}

/** What the customer-facing endpoints expose. Never includes email. */
export interface PublicSpinResult {
  readonly sliceIndex: number;
  readonly rewardKey: RewardKey;
  readonly rewardLabel: string;
  readonly rewardType: "discount" | "gift";
  readonly code: string | null;
  readonly gift: {
    readonly status: GiftStatus;
    readonly variantTitle: string | null;
    readonly selection: Readonly<Record<string, string>> | null;
  } | null;
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
      ? {
          status: record.gift.status,
          variantTitle: record.gift.variantTitle,
          selection: record.gift.selection,
        }
      : null,
    spunAt: record.spunAt,
    expiresAt: record.expiresAt,
    expired: now.getTime() >= Date.parse(record.expiresAt),
    testMode: record.testMode,
  };
}
