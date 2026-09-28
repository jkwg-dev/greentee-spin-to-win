/**
 * What the cart progress bar needs to know: whether the wheel is on right
 * now, and the threshold. Read by the storefront block through the app
 * proxy on every cart view, so it stays small and cacheable.
 *
 * "Open" is stricter than spin eligibility on purpose: only mode `live`
 * counts (test mode shows nothing to anyone), and only inside the campaign
 * window. Tester bypasses do not apply; the bar is a public promise.
 */
import type { CampaignMode } from "~/config/campaign";
import type { AppEnv } from "~/config/env.server";

export interface CartProgressConfig {
  /** True only while a customer checking out now would be offered a spin. */
  readonly open: boolean;
  /** Threshold in major units of `currency`, the same number spin eligibility uses. */
  readonly minSubtotal: number;
  /** The threshold's currency: the shop currency, which is what the order subtotal is compared in. */
  readonly currency: "CAD";
  readonly campaignStart: string;
  readonly campaignEnd: string;
}

export function cartProgressConfig(mode: CampaignMode, env: AppEnv, now: Date): CartProgressConfig {
  const inWindow = now >= env.campaignStart && now < env.campaignEnd;
  return {
    open: mode === "live" && inWindow,
    minSubtotal: env.minSubtotalCad,
    currency: "CAD",
    campaignStart: env.campaignStart.toISOString(),
    campaignEnd: env.campaignEnd.toISOString(),
  };
}
