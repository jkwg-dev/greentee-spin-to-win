import { describe, expect, it } from "vitest";
import { loadEnv } from "~/config/env.server";
import { cartProgressConfig } from "./cart-progress.server";

const env = loadEnv({
  CAMPAIGN_MODE: "live",
  COLLECTION_CLUBS: "gid://shopify/Collection/1",
  COLLECTION_ACCESSORIES: "gid://shopify/Collection/2",
  COLLECTION_APPAREL: "gid://shopify/Collection/3",
  SPIN_SECRET: "0123456789abcdef0123456789abcdef",
  SHOPIFY_API_KEY: "key",
  SHOPIFY_API_SECRET: "secret",
  SHOP_DOMAIN: "greentee.myshopify.com",
});
const IN_WINDOW = new Date("2026-10-10T18:00:00Z");

describe("cartProgressConfig", () => {
  it("is open only in live mode inside the window, with the eligibility threshold", () => {
    expect(cartProgressConfig("live", env, IN_WINDOW)).toEqual({
      open: true,
      minSubtotal: 300,
      currency: "CAD",
      campaignStart: env.campaignStart.toISOString(),
      campaignEnd: env.campaignEnd.toISOString(),
    });
  });

  it("is closed in off and test modes, even inside the window", () => {
    expect(cartProgressConfig("off", env, IN_WINDOW).open).toBe(false);
    expect(cartProgressConfig("test", env, IN_WINDOW).open).toBe(false);
  });

  it("is closed before the start and from the end onwards", () => {
    expect(cartProgressConfig("live", env, new Date("2026-09-30T23:59:59Z")).open).toBe(false);
    expect(cartProgressConfig("live", env, new Date(env.campaignStart)).open).toBe(true);
    expect(cartProgressConfig("live", env, new Date(env.campaignEnd.getTime() - 1)).open).toBe(
      true,
    );
    expect(cartProgressConfig("live", env, env.campaignEnd).open).toBe(false);
  });

  it("follows a changed threshold", () => {
    const env250 = loadEnv({
      CAMPAIGN_MODE: "live",
      MIN_SUBTOTAL_CAD: "250",
      COLLECTION_CLUBS: "gid://shopify/Collection/1",
      COLLECTION_ACCESSORIES: "gid://shopify/Collection/2",
      COLLECTION_APPAREL: "gid://shopify/Collection/3",
      SPIN_SECRET: "0123456789abcdef0123456789abcdef",
      SHOPIFY_API_KEY: "key",
      SHOPIFY_API_SECRET: "secret",
      SHOP_DOMAIN: "greentee.myshopify.com",
    });
    expect(cartProgressConfig("live", env250, IN_WINDOW).minSubtotal).toBe(250);
  });
});
