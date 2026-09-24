/**
 * Pure eligibility rules. No I/O, so every branch is unit testable.
 */
import type { AppEnv } from "~/config/env.server";
import type { CampaignMode } from "~/config/campaign";
import { normalizeTag } from "~/config/env.server";
import type { SpinResultRecord } from "~/lib/spin-result";

export interface OrderSnapshot {
  /** Numeric ID as a string. */
  readonly id: string;
  readonly gid: string;
  /** e.g. "#1234" */
  readonly name: string;
  readonly email: string | null;
  readonly createdAt: string;
  /** Shopify's order status page, where the read-only extension shows the reward. */
  readonly statusPageUrl: string | null;
  /** currentSubtotalPriceSet.shopMoney: after discounts, before tax and shipping. */
  readonly subtotal: { readonly amount: number; readonly currencyCode: string };
  readonly tags: readonly string[];
  readonly spinResult: SpinResultRecord | null;
}

/**
 * A test user is identified from the order alone: its own tags, or its email
 * in TEST_EMAILS. Customer tags are deliberately not consulted, because
 * reading `order.customer` needs the `read_customers` scope that this app
 * does not request. Tag an order, not a customer.
 */
export function isTestUser(order: OrderSnapshot, env: AppEnv): boolean {
  if (order.tags.some((t) => normalizeTag(t) === env.testTag)) return true;
  if (order.email && env.testEmails.has(normalizeTag(order.email))) return true;
  return false;
}

export type IneligibleReason = "before_start" | "after_end" | "below_minimum";

export type Eligibility =
  | { readonly campaignOpen: false; readonly isTestUser: boolean }
  | {
      readonly campaignOpen: true;
      readonly isTestUser: boolean;
      readonly eligible: true;
      readonly bypassedMinimum: boolean;
    }
  | {
      readonly campaignOpen: true;
      readonly isTestUser: boolean;
      readonly eligible: false;
      readonly reason: IneligibleReason;
    };

/**
 * Decides whether an order may spin. Does not look at an existing spin
 * result; callers check that first so an already spun order always gets its
 * stored result back, even after the campaign closes.
 *
 * Test users bypass the campaign start date: their whole purpose is exercising
 * the flow before October 1 and their spins are flagged and cleaned up. They
 * never bypass the end date, so a stale test link cannot mint a code after the
 * promotion has closed. They bypass the minimum subtotal only when
 * TEST_BYPASS_MIN_SUBTOTAL is set. Nothing is bypassed for anyone else.
 */
export function evaluateEligibility(
  order: OrderSnapshot,
  env: AppEnv,
  mode: CampaignMode,
  now: Date,
): Eligibility {
  const tester = isTestUser(order, env);
  if (mode === "off") return { campaignOpen: false, isTestUser: tester };
  if (mode === "test" && !tester) return { campaignOpen: false, isTestUser: tester };

  if (!tester && now < env.campaignStart) {
    return { campaignOpen: true, isTestUser: tester, eligible: false, reason: "before_start" };
  }
  if (now >= env.campaignEnd) {
    return { campaignOpen: true, isTestUser: tester, eligible: false, reason: "after_end" };
  }

  const bypass = tester && env.testBypassMinSubtotal;
  if (!bypass && order.subtotal.amount < env.minSubtotalCad) {
    return { campaignOpen: true, isTestUser: tester, eligible: false, reason: "below_minimum" };
  }
  return { campaignOpen: true, isTestUser: tester, eligible: true, bypassedMinimum: bypass };
}
