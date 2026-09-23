import { describe, expect, it } from "vitest";
import { loadEnv, normalizeTag } from "./env.server";

const VALID = {
  CAMPAIGN_MODE: "test",
  COLLECTION_CLUBS: "gid://shopify/Collection/1",
  COLLECTION_ACCESSORIES: "gid://shopify/Collection/2",
  COLLECTION_APPAREL: "gid://shopify/Collection/3",
  SPIN_SECRET: "0123456789abcdef0123456789abcdef",
  APP_URL: "https://spin.example.com/",
  SHOPIFY_API_KEY: "key",
  SHOPIFY_API_SECRET: "secret",
  SHOP_DOMAIN: "GreenTee-Golf.myshopify.com",
};

describe("loadEnv", () => {
  it("parses a valid environment with defaults", () => {
    const env = loadEnv(VALID);
    expect(env.campaignMode).toBe("test");
    expect(env.minSubtotalCad).toBe(300);
    expect(env.testTag).toBe("test-user");
    expect(env.testEmails.size).toBe(0);
    expect(env.testBypassMinSubtotal).toBe(false);
    expect(env.omnisendTestSends).toBe(false);
    expect(env.omnisendApiKey).toBeUndefined();
    expect(env.appUrl).toBe("https://spin.example.com");
    expect(env.shopDomain).toBe("greentee-golf.myshopify.com");
    expect(env.spinPageUrl).toBe("https://greentee-golf.myshopify.com/pages/spin-to-win");
    // Defaults from campaign.ts, interpreted in America/Vancouver.
    expect(env.campaignStart.toISOString()).toBe("2026-10-01T07:00:00.000Z");
    expect(env.campaignEnd.toISOString()).toBe("2026-11-02T17:00:00.000Z");
  });

  it("defaults CAMPAIGN_MODE to off when unset", () => {
    const { CAMPAIGN_MODE: _omit, ...rest } = VALID;
    expect(loadEnv(rest).campaignMode).toBe("off");
  });

  it("rejects an unknown CAMPAIGN_MODE", () => {
    expect(() => loadEnv({ ...VALID, CAMPAIGN_MODE: "on" })).toThrow(
      /CAMPAIGN_MODE must be one of/,
    );
  });

  it("normalises the test tag and email allowlist", () => {
    const env = loadEnv({
      ...VALID,
      TEST_TAG: "  Test-User ",
      TEST_EMAILS: " Kelly@Example.com, , qa@example.com ",
    });
    expect(env.testTag).toBe("test-user");
    expect([...env.testEmails]).toEqual(["kelly@example.com", "qa@example.com"]);
  });

  it("parses booleans leniently and rejects garbage", () => {
    expect(loadEnv({ ...VALID, TEST_BYPASS_MIN_SUBTOTAL: "TRUE" }).testBypassMinSubtotal).toBe(
      true,
    );
    expect(loadEnv({ ...VALID, OMNISEND_TEST_SENDS: "1" }).omnisendTestSends).toBe(true);
    expect(() => loadEnv({ ...VALID, TEST_BYPASS_MIN_SUBTOTAL: "maybe" })).toThrow(
      /TEST_BYPASS_MIN_SUBTOTAL must be true or false/,
    );
  });

  it("accepts explicit campaign dates and rejects an inverted window", () => {
    const env = loadEnv({
      ...VALID,
      CAMPAIGN_START: "2026-09-25",
      CAMPAIGN_END: "2026-09-30T12:00",
    });
    expect(env.campaignStart.toISOString()).toBe("2026-09-25T07:00:00.000Z");
    expect(env.campaignEnd.toISOString()).toBe("2026-09-30T19:00:00.000Z");
    expect(() => loadEnv({ ...VALID, CAMPAIGN_END: "2026-09-01" })).toThrow(
      /CAMPAIGN_END must be after/,
    );
  });

  it("reports every problem at once", () => {
    expect(() => loadEnv({})).toThrow(
      /COLLECTION_CLUBS is required[\s\S]*SPIN_SECRET[\s\S]*SHOP_DOMAIN/,
    );
  });

  it("boots without APP_URL but rejects a relative one", () => {
    const { APP_URL: _omit, ...rest } = VALID;
    expect(loadEnv(rest).appUrl).toBeUndefined();
    expect(() => loadEnv({ ...rest, APP_URL: "spin.example.com" })).toThrow(/APP_URL/);
  });

  it("requires collection GIDs, not handles", () => {
    expect(() => loadEnv({ ...VALID, COLLECTION_CLUBS: "regular-priced-clubs" })).toThrow(
      /COLLECTION_CLUBS must be a Collection GID/,
    );
  });

  it("falls back to SHOPIFY_APP_URL from the CLI", () => {
    const { APP_URL: _omit, ...rest } = VALID;
    expect(loadEnv({ ...rest, SHOPIFY_APP_URL: "https://tunnel.trycloudflare.com" }).appUrl).toBe(
      "https://tunnel.trycloudflare.com",
    );
  });
});

describe("SPIN_PAGE_URL", () => {
  it("accepts an absolute storefront URL and rejects a query string", () => {
    expect(
      loadEnv({ ...VALID, SPIN_PAGE_URL: "https://www.greenteegolf.ca/pages/spin/" }).spinPageUrl,
    ).toBe("https://www.greenteegolf.ca/pages/spin");
    expect(() => loadEnv({ ...VALID, SPIN_PAGE_URL: "https://x.com/p?x=1" })).toThrow(
      /SPIN_PAGE_URL/,
    );
  });
});

describe("normalizeTag", () => {
  it("trims and lower-cases", () => {
    expect(normalizeTag("  Test-USER ")).toBe("test-user");
  });
});
