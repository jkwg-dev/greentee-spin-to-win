import { describe, expect, it } from "vitest";
import { loadEnv } from "~/config/env.server";
import { evaluateEligibility, isTestUser, type OrderSnapshot } from "./eligibility";

const BASE_ENV = {
  CAMPAIGN_MODE: "live",
  COLLECTION_CLUBS: "gid://shopify/Collection/1",
  COLLECTION_ACCESSORIES: "gid://shopify/Collection/2",
  COLLECTION_APPAREL: "gid://shopify/Collection/3",
  SPIN_SECRET: "0123456789abcdef0123456789abcdef",
  APP_URL: "https://spin.example.com",
  SHOPIFY_API_KEY: "key",
  SHOPIFY_API_SECRET: "secret",
  SHOP_DOMAIN: "greentee.myshopify.com",
  TEST_EMAILS: "qa@example.com",
};

const env = loadEnv(BASE_ENV);
const IN_WINDOW = new Date("2026-10-10T18:00:00Z");
const BEFORE = new Date("2026-09-28T18:00:00Z");
const AFTER = new Date("2026-11-02T17:00:00Z"); // exactly campaign end

function order(over: Partial<OrderSnapshot> = {}): OrderSnapshot {
  return {
    id: "1",
    gid: "gid://shopify/Order/1",
    name: "#1001",
    email: "buyer@example.com",
    createdAt: IN_WINDOW.toISOString(),
    statusPageUrl: "https://greentee.myshopify.com/orders/abc",
    subtotal: { amount: 300, currencyCode: "CAD" },
    tags: [],
    customer: { id: "gid://shopify/Customer/1", tags: [] },
    spinResult: null,
    ...over,
  };
}

describe("isTestUser", () => {
  it("matches the customer tag case-insensitively with whitespace", () => {
    expect(isTestUser(order({ customer: { id: "c", tags: [" Test-USER "] } }), env)).toBe(true);
    expect(isTestUser(order({ customer: { id: "c", tags: ["vip"] } }), env)).toBe(false);
  });

  it("matches the order tag, covering guest checkouts", () => {
    expect(isTestUser(order({ customer: null, tags: ["TEST-user"] }), env)).toBe(true);
  });

  it("matches the email allowlist case-insensitively", () => {
    expect(isTestUser(order({ email: "QA@Example.com" }), env)).toBe(true);
    expect(isTestUser(order({ email: "someone@example.com" }), env)).toBe(false);
  });

  it("is false for an ordinary guest order", () => {
    expect(isTestUser(order({ customer: null }), env)).toBe(false);
  });
});

describe("evaluateEligibility: subtotal boundary", () => {
  it("passes at exactly 300.00 and fails at 299.99", () => {
    expect(
      evaluateEligibility(
        order({ subtotal: { amount: 300, currencyCode: "CAD" } }),
        env,
        "live",
        IN_WINDOW,
      ),
    ).toMatchObject({
      campaignOpen: true,
      eligible: true,
      bypassedMinimum: false,
    });
    expect(
      evaluateEligibility(
        order({ subtotal: { amount: 299.99, currencyCode: "CAD" } }),
        env,
        "live",
        IN_WINDOW,
      ),
    ).toMatchObject({
      campaignOpen: true,
      eligible: false,
      reason: "below_minimum",
    });
  });

  it("honours a changed threshold from config", () => {
    const env250 = loadEnv({ ...BASE_ENV, MIN_SUBTOTAL_CAD: "250" });
    expect(
      evaluateEligibility(
        order({ subtotal: { amount: 250, currencyCode: "CAD" } }),
        env250,
        "live",
        IN_WINDOW,
      ),
    ).toMatchObject({ eligible: true });
  });
});

describe("evaluateEligibility: modes", () => {
  it("off closes the campaign for everyone, including testers", () => {
    expect(evaluateEligibility(order(), env, "off", IN_WINDOW)).toEqual({
      campaignOpen: false,
      isTestUser: false,
    });
    expect(evaluateEligibility(order({ tags: ["test-user"] }), env, "off", IN_WINDOW)).toEqual({
      campaignOpen: false,
      isTestUser: true,
    });
  });

  it("test mode closes the campaign for non-testers and opens it for testers", () => {
    expect(evaluateEligibility(order(), env, "test", IN_WINDOW)).toEqual({
      campaignOpen: false,
      isTestUser: false,
    });
    expect(
      evaluateEligibility(order({ tags: ["test-user"] }), env, "test", IN_WINDOW),
    ).toMatchObject({
      campaignOpen: true,
      isTestUser: true,
      eligible: true,
    });
  });

  it("live mode still flags testers", () => {
    expect(
      evaluateEligibility(order({ tags: ["test-user"] }), env, "live", IN_WINDOW),
    ).toMatchObject({
      campaignOpen: true,
      isTestUser: true,
      eligible: true,
    });
  });
});

describe("evaluateEligibility: campaign window", () => {
  it("is not eligible before start or at/after end for ordinary customers", () => {
    expect(evaluateEligibility(order(), env, "live", BEFORE)).toMatchObject({
      eligible: false,
      reason: "before_start",
    });
    expect(evaluateEligibility(order(), env, "live", AFTER)).toMatchObject({
      eligible: false,
      reason: "after_end",
    });
  });

  it("lets testers spin outside the window so the flow can be exercised before launch", () => {
    expect(evaluateEligibility(order({ tags: ["test-user"] }), env, "test", BEFORE)).toMatchObject({
      eligible: true,
    });
  });
});

describe("evaluateEligibility: TEST_BYPASS_MIN_SUBTOTAL", () => {
  const bypassEnv = loadEnv({ ...BASE_ENV, TEST_BYPASS_MIN_SUBTOTAL: "true" });

  it("skips the minimum for testers only", () => {
    const cheap = { amount: 12.5, currencyCode: "CAD" };
    expect(
      evaluateEligibility(
        order({ subtotal: cheap, tags: ["test-user"] }),
        bypassEnv,
        "live",
        IN_WINDOW,
      ),
    ).toMatchObject({
      eligible: true,
      bypassedMinimum: true,
    });
    expect(
      evaluateEligibility(order({ subtotal: cheap }), bypassEnv, "live", IN_WINDOW),
    ).toMatchObject({
      eligible: false,
      reason: "below_minimum",
    });
  });

  it("does nothing when the flag is off", () => {
    expect(
      evaluateEligibility(
        order({ subtotal: { amount: 12.5, currencyCode: "CAD" }, tags: ["test-user"] }),
        env,
        "live",
        IN_WINDOW,
      ),
    ).toMatchObject({
      eligible: false,
      reason: "below_minimum",
    });
  });
});
