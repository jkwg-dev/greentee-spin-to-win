/**
 * The spin use cases. Everything the three endpoints do is here, with I/O
 * injected so the whole flow, including the idempotency path, is unit tested.
 */
import {
  DISCOUNT_TITLE,
  SLICES,
  SPIN_RESULT_VERSION,
  SPIN_TOKEN_TTL_SECONDS,
  giftProductFor,
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
import {
  addGiftToOrder,
  buildOffer,
  findGiftLine,
  loadGiftProduct,
  pickVariant,
  tagGiftAdded,
  tagGiftPending,
  type GiftOffer,
} from "~/lib/gifts.server";
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
import {
  toPublicResult,
  type GiftRecord,
  type PublicSpinResult,
  type SpinResultRecord,
} from "~/lib/spin-result";
import { createSpinToken } from "~/lib/spin-token.server";

export interface SpinDeps {
  readonly admin: AdminClient;
  readonly env: AppEnv;
  readonly now?: () => Date;
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
      /** Thank you page only: present while a won gift still needs confirming. */
      readonly spinUrl?: string;
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
  /** Present while a won gift is pending or unavailable, so the page can render the gift step. */
  readonly giftOffer?: GiftOffer | null;
};

export type SpinExecution =
  | { readonly campaignOpen: false }
  | {
      readonly campaignOpen: true;
      readonly alreadySpun: boolean;
      readonly forced: boolean;
      readonly result: PublicSpinResult;
      readonly giftOffer?: GiftOffer | null;
    };

export type GiftConfirmation = {
  readonly campaignOpen: true;
  readonly result: PublicSpinResult;
  readonly giftOffer: GiftOffer | null;
  /** Customer facing line when the gift could not be added. */
  readonly message?: string;
};

export const GIFT_MESSAGES = {
  unavailable:
    "We're sorry, that gift is out of stock right now. Please contact us and we'll sort it out.",
} as const;

/** Loads the live offer for a stored gift, or null when the gift is already added or on failure. */
async function offerFor(order: OrderSnapshot, deps: SpinDeps): Promise<GiftOffer | null> {
  const r = order.spinResult;
  if (!r || r.rewardType !== "gift" || !r.gift || r.gift.status === "added") return null;
  const product = giftProductFor(r.rewardKey);
  if (!product) return null;
  try {
    const gp = await loadGiftProduct(deps.admin, product, order.id);
    return buildOffer(product, gp.variants, gp.imageUrl);
  } catch (error) {
    log.warn("gift.offer.unavailable", { orderId: order.id, error });
    return null;
  }
}

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
    // A gift that has not been added yet can still be finished on the spin
    // page, so the Thank you page keeps its link while the campaign is open.
    const giftOpen = order.spinResult.gift?.status !== "added" && now < deps.env.campaignEnd;
    return {
      campaignOpen: true,
      pending: false,
      alreadySpun: true,
      eligible: true,
      testMode: order.spinResult.testMode,
      result: toPublicResult(order.spinResult, now),
      ...(withSpinUrl && order.spinResult.rewardType === "gift" && giftOpen
        ? { spinUrl: spinUrlFor(order, deps, now) }
        : {}),
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
    ...(withSpinUrl ? { spinUrl: spinUrlFor(order, deps, now) } : {}),
  };
}

function spinUrlFor(order: OrderSnapshot, deps: SpinDeps, now: Date): string {
  const token = createSpinToken(deps.env.spinSecret, order.id, SPIN_TOKEN_TTL_SECONDS, now);
  return `${deps.env.spinPageUrl}?token=${encodeURIComponent(token)}`;
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
  if (!status.campaignOpen) return status;
  const giftOffer = await offerFor(order, deps);
  return { ...status, wheel: WHEEL, orderUrl: order.statusPageUrl, giftOffer };
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
  let gift: GiftRecord | null = null;

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
    // Nothing is added yet. The record and the gift-pending tag are written
    // first so staff can find anyone who closes the page before confirming.
    const product = giftProductFor(slice.rewardKey);
    if (!product)
      throw new SpinError(500, "gift_not_configured", `No gift product for ${slice.rewardKey}`);
    gift = {
      status: "pending",
      productId: product.productId,
      variantId: null,
      variantTitle: null,
      lineItemId: null,
      orderEditId: null,
      reference: derived.giftReference,
      selection: null,
      reason: null,
      updatedAt: now.toISOString(),
    };
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

  if (gift) {
    try {
      await tagGiftPending(deps.admin, order.gid, id);
    } catch (error) {
      // The record already says pending; the tag is for staff convenience.
      l.error("spin.execute.gift_tag_failed", { error });
    }
  }

  l.info("spin.execute.done", {
    sliceIndex: slice.index,
    rewardKey: slice.rewardKey,
    code,
    discountNodeId,
    testMode: tester,
    forced: forcing,
    roll: derived.roll,
  });
  const giftOffer = gift ? await offerFor({ ...order, spinResult: record }, deps) : null;
  return {
    campaignOpen: true,
    alreadySpun: false,
    forced: forcing,
    result: toPublicResult(record, now),
    ...(gift ? { giftOffer } : {}),
  };
}

export interface ConfirmGiftOptions {
  /** e.g. { Size: "22" }. Ignored for gifts with nothing to choose. */
  readonly selection?: Readonly<Record<string, string>> | null;
}

/**
 * Adds the won gift to the order. Idempotent: an added gift returns as is; a
 * gift line already on the order (crash after commit) is adopted; anything
 * out of stock leaves the order untouched and the tag at gift-pending.
 */
export async function confirmGift(
  orderId: string | number,
  opts: ConfirmGiftOptions,
  deps: SpinDeps,
): Promise<GiftConfirmation> {
  const id = normalizeOrderId(orderId);
  const now = (deps.now ?? (() => new Date()))();
  const l = log.child({ orderId: id });

  const mode = await resolveCampaignMode(deps.admin, deps.env);
  if (mode === "off")
    throw new SpinError(409, "campaign_closed", "Spin to Win is closed right now.");

  const order = await fetchOrder(deps.admin, id, deps.fetchOrderOpts);
  if (!order)
    throw new SpinError(503, "order_pending", "Order is not available yet", { retryable: true });
  const record = order.spinResult;
  if (!record) throw new SpinError(409, "not_spun", "This order has not spun yet.");
  if (record.rewardType !== "gift" || !record.gift)
    throw new SpinError(409, "not_a_gift", "This order did not win a gift.");
  if (mode === "test" && !isTestUser(order, deps.env))
    throw new SpinError(409, "campaign_closed", "Spin to Win is closed right now.");
  const product = giftProductFor(record.rewardKey);
  if (!product)
    throw new SpinError(500, "gift_not_configured", `No gift product for ${record.rewardKey}`);

  if (record.gift.status === "added") {
    l.info("gift.confirm.already_added", { variantId: record.gift.variantId });
    return { campaignOpen: true, result: toPublicResult(record, now), giftOffer: null };
  }

  const persist = async (gift: GiftRecord): Promise<SpinResultRecord> => {
    const next: SpinResultRecord = { ...record, gift };
    await writeSpinResult(deps.admin, id, order.gid, next);
    invalidateOrderCache(id);
    return next;
  };

  // Crash between commit and the metafield write: adopt the existing line rather than add another.
  const existing = await findGiftLine(deps.admin, order.gid, id, product.productId);
  if (existing) {
    l.info("gift.confirm.adopted_existing_line", { ...existing });
    const next = await persist({
      ...record.gift,
      status: "added",
      variantId: existing.variantId,
      lineItemId: existing.lineItemId,
      reason: null,
      updatedAt: now.toISOString(),
    });
    await tagGiftAdded(deps.admin, order.gid, id);
    return { campaignOpen: true, result: toPublicResult(next, now), giftOffer: null };
  }

  const { variants, imageUrl } = await loadGiftProduct(deps.admin, product, id);
  const selection = product.customerOption ? (opts.selection ?? null) : null;
  const pick = pickVariant(product, variants, selection);
  if (!pick.ok) {
    if (pick.reason === "selection_required" || pick.reason === "invalid_selection") {
      throw new SpinError(400, pick.reason, `Please choose a ${product.customerOption}.`);
    }
    // Out of stock: do not edit the order, keep gift-pending, record why.
    l.warn("gift.confirm.unavailable", { selection, reason: pick.reason });
    const next = await persist({
      ...record.gift,
      status: "unavailable",
      selection,
      reason: `no_stock${selection ? ` for ${JSON.stringify(selection)}` : ""} at ${now.toISOString()}`,
      updatedAt: now.toISOString(),
    });
    return {
      campaignOpen: true,
      result: toPublicResult(next, now),
      giftOffer: buildOffer(product, variants, imageUrl),
      message: GIFT_MESSAGES.unavailable,
    };
  }

  let added: { orderEditId: string; lineItemId: string | null };
  try {
    added = await addGiftToOrder(deps.admin, {
      orderId: id,
      orderGid: order.gid,
      variant: pick.variant,
      product,
      reference: record.gift.reference,
    });
  } catch (error) {
    // Nothing committed (or commit failed): record and tag are unchanged, retry is safe.
    l.error("gift.confirm.edit_failed", { error, variantId: pick.variant.id });
    throw new SpinError(503, "gift_edit_failed", "We could not add your gift. Please try again.", {
      retryable: true,
    });
  }

  const next = await persist({
    ...record.gift,
    status: "added",
    variantId: pick.variant.id,
    variantTitle: pick.variant.title,
    lineItemId: added.lineItemId,
    orderEditId: added.orderEditId,
    selection,
    reason: null,
    updatedAt: now.toISOString(),
  });
  await tagGiftAdded(deps.admin, order.gid, id);
  l.info("gift.confirm.done", {
    variantId: pick.variant.id,
    lineItemId: added.lineItemId,
    selection,
  });
  return { campaignOpen: true, result: toPublicResult(next, now), giftOffer: null };
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
