/**
 * The spin use cases. Everything the three endpoints do is here, with I/O
 * injected so the whole flow, including the idempotency path, is unit tested.
 */
import {
  DISCOUNT_TITLE,
  SLICES,
  SPIN_RESULT_VERSION,
  SPIN_TOKEN_TTL_SECONDS,
  type CampaignMode,
  type Slice,
} from "~/config/campaign";
import type { AppEnv } from "~/config/env.server";
import type { AdminClient } from "~/lib/admin.server";
import { ensureDiscount } from "~/lib/discounts.server";
import {
  evaluateEligibility,
  isTestUser,
  type IneligibleReason,
  type OrderSnapshot,
} from "~/lib/eligibility";
import { unimplementedGiftIssuer, type GiftIssuer } from "~/lib/gifts.server";
import { log } from "~/lib/log.server";
import { resolveCampaignMode, writeSpinResult } from "~/lib/metafields.server";
import {
  fetchOrder,
  fetchOrderCached,
  invalidateOrderCache,
  type FetchOrderOptions,
} from "~/lib/orders.server";
import {
  ForceSliceError,
  deriveOutcome,
  normalizeOrderId,
  resolveForcedSlice,
} from "~/lib/outcome";
import { toPublicResult, type PublicSpinResult, type SpinResultRecord } from "~/lib/spin-result";
import { createSpinToken } from "~/lib/spin-token.server";

export interface SpinDeps {
  readonly admin: AdminClient;
  readonly env: AppEnv;
  readonly now?: () => Date;
  readonly giftIssuer?: GiftIssuer;
  readonly fetchOrderOpts?: FetchOrderOptions;
}

export class SpinError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryable: boolean;
  readonly details: unknown;
  constructor(
    status: number,
    code: string,
    message: string,
    opts: { retryable?: boolean; details?: unknown } = {},
  ) {
    super(message);
    this.name = "SpinError";
    this.status = status;
    this.code = code;
    this.retryable = opts.retryable ?? false;
    this.details = opts.details;
  }
  toJSON() {
    return { error: this.code, message: this.message, retryable: this.retryable };
  }
}

/** Customer facing copy for each ineligible reason. Encouraging, never an error. */
export const INELIGIBLE_MESSAGES: Record<IneligibleReason, string> = {
  before_start: "Spin to Win starts October 1. Come back then with your next order.",
  after_end: "Spin to Win has wrapped up for this year. Thanks for shopping with GreenTee!",
  below_minimum: "Orders of $300 or more unlock a spin on the GreenTee wheel. Next time!",
};

export interface WheelSlice {
  readonly index: number;
  /** Short label for the wheel face. */
  readonly label: string;
  readonly icon: Slice["icon"];
  readonly rewardType: Slice["rewardType"];
}

/** What the storefront wheel draws. It never sees probabilities. */
export const WHEEL: readonly WheelSlice[] = SLICES.map((s) => ({
  index: s.index,
  label: s.wheelLabel,
  icon: s.icon,
  rewardType: s.rewardType,
}));

export type SpinStatus =
  | { readonly campaignOpen: false }
  | { readonly campaignOpen: true; readonly pending: true }
  | {
      readonly campaignOpen: true;
      readonly pending: false;
      readonly alreadySpun: true;
      readonly eligible: true;
      readonly testMode: boolean;
      readonly result: PublicSpinResult;
    }
  | {
      readonly campaignOpen: true;
      readonly pending: false;
      readonly alreadySpun: false;
      readonly eligible: true;
      readonly testMode: boolean;
      /** Present on the Thank you page status only. */
      readonly spinUrl?: string;
    }
  | {
      readonly campaignOpen: true;
      readonly pending: false;
      readonly alreadySpun: false;
      readonly eligible: false;
      readonly testMode: boolean;
      readonly reason: IneligibleReason;
      readonly message: string;
    };

export type SpinState = SpinStatus & {
  readonly wheel?: readonly WheelSlice[];
  /** Where the spin page's "Back to your order" button goes. */
  readonly orderUrl?: string | null;
};

export type SpinExecution =
  | { readonly campaignOpen: false }
  | {
      readonly campaignOpen: true;
      readonly alreadySpun: boolean;
      readonly forced: boolean;
      readonly result: PublicSpinResult;
    };

function buildStatus(
  order: OrderSnapshot,
  mode: CampaignMode,
  deps: SpinDeps,
  withSpinUrl: boolean,
): SpinStatus {
  const now = (deps.now ?? (() => new Date()))();
  const elig = evaluateEligibility(order, deps.env, mode, now);
  if (!elig.campaignOpen) return { campaignOpen: false };

  // A stored result always wins, even after the campaign closes.
  if (order.spinResult) {
    return {
      campaignOpen: true,
      pending: false,
      alreadySpun: true,
      eligible: true,
      testMode: order.spinResult.testMode,
      result: toPublicResult(order.spinResult, now),
    };
  }
  if (!elig.eligible) {
    return {
      campaignOpen: true,
      pending: false,
      alreadySpun: false,
      eligible: false,
      testMode: elig.isTestUser,
      reason: elig.reason,
      message: INELIGIBLE_MESSAGES[elig.reason],
    };
  }
  return {
    campaignOpen: true,
    pending: false,
    alreadySpun: false,
    eligible: true,
    testMode: elig.isTestUser,
    ...(withSpinUrl
      ? {
          spinUrl: `${deps.env.spinPageUrl}?token=${encodeURIComponent(
            createSpinToken(deps.env.spinSecret, order.id, SPIN_TOKEN_TTL_SECONDS, now),
          )}`,
        }
      : {}),
  };
}

/** Thank you page: eligibility plus a signed link to the spin page. */
export async function getSpinStatus(orderId: string | number, deps: SpinDeps): Promise<SpinStatus> {
  const id = normalizeOrderId(orderId);
  const mode = await resolveCampaignMode(deps.admin, deps.env);
  if (mode === "off") return { campaignOpen: false };
  const order = await fetchOrderCached(deps.admin, id, deps.fetchOrderOpts);
  if (!order) return { campaignOpen: true, pending: true };
  const status = buildStatus(order, mode, deps, true);
  log.info("spin.status", { orderId: id, mode, ...summarize(status) });
  return status;
}

/** Spin page: current state plus the wheel labels, so the theme block holds no reward table. */
export async function getSpinState(orderId: string | number, deps: SpinDeps): Promise<SpinState> {
  const id = normalizeOrderId(orderId);
  const mode = await resolveCampaignMode(deps.admin, deps.env);
  if (mode === "off") return { campaignOpen: false };
  const order = await fetchOrderCached(deps.admin, id, deps.fetchOrderOpts);
  if (!order) return { campaignOpen: true, pending: true };
  const status = buildStatus(order, mode, deps, false);
  log.info("spin.state", { orderId: id, mode, ...summarize(status) });
  return status.campaignOpen ? { ...status, wheel: WHEEL, orderUrl: order.statusPageUrl } : status;
}

export interface ExecuteOptions {
  /** Test users only. 1 to 9; slice 10 is rejected. */
  readonly forceSlice?: unknown;
}

/**
 * Performs the spin. Idempotent by construction: the slice and the code are
 * derived from the order ID, the discount is created at most once (a
 * duplicate is looked up and reused), and the metafield is written last as
 * an upsert of identical content.
 */
export async function executeSpin(
  orderId: string | number,
  opts: ExecuteOptions,
  deps: SpinDeps,
): Promise<SpinExecution> {
  const id = normalizeOrderId(orderId);
  const now = (deps.now ?? (() => new Date()))();
  const l = log.child({ orderId: id });

  const mode = await resolveCampaignMode(deps.admin, deps.env);
  if (mode === "off") {
    l.info("spin.execute.closed", { mode });
    return { campaignOpen: false };
  }

  // Always a fresh read here: the cache is for status polling only.
  const order = await fetchOrder(deps.admin, id, deps.fetchOrderOpts);
  if (!order)
    throw new SpinError(503, "order_pending", "Order is not available yet", { retryable: true });

  const tester = isTestUser(order, deps.env);
  if (mode === "test" && !tester) {
    l.info("spin.execute.closed", { mode, reason: "not_test_user" });
    return { campaignOpen: false };
  }

  const forcing =
    opts.forceSlice !== undefined && opts.forceSlice !== null && opts.forceSlice !== "";
  if (forcing && !tester) {
    l.warn("spin.execute.force_denied");
    throw new SpinError(403, "force_not_allowed", "forceSlice is only available to test users");
  }

  if (order.spinResult) {
    l.info("spin.execute.already_spun", {
      code: order.spinResult.code,
      sliceIndex: order.spinResult.sliceIndex,
    });
    return {
      campaignOpen: true,
      alreadySpun: true,
      forced: order.spinResult.forced,
      result: toPublicResult(order.spinResult, now),
    };
  }

  const elig = evaluateEligibility(order, deps.env, mode, now);
  if (!elig.campaignOpen) return { campaignOpen: false };
  if (!elig.eligible) {
    l.info("spin.execute.not_eligible", { reason: elig.reason, subtotal: order.subtotal.amount });
    throw new SpinError(409, "not_eligible", INELIGIBLE_MESSAGES[elig.reason], {
      details: { reason: elig.reason },
    });
  }

  const derived = deriveOutcome(deps.env.spinSecret, id, { testMode: tester });
  let slice: Slice = derived.slice;
  if (forcing) {
    try {
      slice = resolveForcedSlice(opts.forceSlice);
    } catch (e) {
      if (e instanceof ForceSliceError) throw new SpinError(400, "invalid_force_slice", e.message);
      throw e;
    }
    l.info("spin.execute.forced", { forceSlice: slice.index, derivedSlice: derived.slice.index });
  }

  let code: string | null = null;
  let discountNodeId: string | null = null;
  let gift: SpinResultRecord["gift"] = null;

  if (slice.rewardType === "discount" && slice.discount) {
    const title = `${tester ? DISCOUNT_TITLE.testPrefix : DISCOUNT_TITLE.prefix} ${slice.label} ${order.name}`;
    try {
      const ensured = await ensureDiscount(deps.admin, {
        orderId: id,
        code: derived.discountCode,
        title,
        percentage: slice.discount.percentage,
        collectionId: deps.env.collections[slice.discount.collection],
        startsAt: now,
        endsAt: deps.env.campaignEnd,
      });
      code = ensured.code;
      discountNodeId = ensured.discountNodeId;
    } catch (error) {
      l.error("spin.execute.discount_failed", { error, sliceIndex: slice.index });
      const retryable = (error as { retryable?: boolean }).retryable ?? true;
      throw new SpinError(
        retryable ? 503 : 500,
        "discount_failed",
        "We could not create your code. Please try again.",
        {
          retryable,
        },
      );
    }
  } else if (slice.rewardType === "gift") {
    try {
      gift = await (deps.giftIssuer ?? unimplementedGiftIssuer).issue({
        admin: deps.admin,
        orderId: id,
        orderGid: order.gid,
        slice,
        giftReference: derived.giftReference,
        testMode: tester,
      });
    } catch (error) {
      l.error("spin.execute.gift_failed", { error, sliceIndex: slice.index });
      throw new SpinError(
        503,
        "gift_unavailable",
        "We could not add your gift. Please try again.",
        { retryable: true },
      );
    }
  } else {
    // Only slice 10 has no reward and it is unreachable; treat as a bug.
    throw new SpinError(500, "invalid_slice", `Slice ${slice.index} awards nothing`);
  }

  const record: SpinResultRecord = {
    version: SPIN_RESULT_VERSION,
    spunAt: now.toISOString(),
    sliceIndex: slice.index,
    rewardKey: slice.rewardKey,
    rewardLabel: slice.label,
    rewardType: slice.rewardType as "discount" | "gift",
    code,
    discountNodeId,
    gift,
    expiresAt: deps.env.campaignEnd.toISOString(),
    email: order.email,
    testMode: tester,
    forced: forcing,
  };

  try {
    await writeSpinResult(deps.admin, id, order.gid, record);
  } catch (error) {
    // The discount exists. A retry derives the same code, hits the duplicate
    // path and completes the write, so this is safe to surface as retryable.
    l.error("spin.execute.metafield_failed", { error });
    throw new SpinError(503, "record_failed", "We could not save your result. Please try again.", {
      retryable: true,
    });
  }
  invalidateOrderCache(id);

  l.info("spin.execute.done", {
    sliceIndex: slice.index,
    rewardKey: slice.rewardKey,
    code,
    discountNodeId,
    testMode: tester,
    forced: forcing,
    roll: derived.roll,
  });
  return {
    campaignOpen: true,
    alreadySpun: false,
    forced: forcing,
    result: toPublicResult(record, now),
  };
}

function summarize(status: SpinStatus): Record<string, unknown> {
  if (!status.campaignOpen) return { campaignOpen: false };
  if (status.pending) return { pending: true };
  if (status.alreadySpun)
    return {
      alreadySpun: true,
      sliceIndex: status.result.sliceIndex,
      expired: status.result.expired,
    };
  return {
    eligible: status.eligible,
    ...("reason" in status ? { reason: status.reason } : {}),
    testMode: status.testMode,
  };
}
