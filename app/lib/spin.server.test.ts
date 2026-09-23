import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISCOUNT_TITLE, SLICES } from "~/config/campaign";
import { loadEnv, type AppEnv } from "~/config/env.server";
import type { AdminClient, GraphqlContext, UserError } from "~/lib/admin.server";
import type { GiftIssuer } from "~/lib/gifts.server";
import { setLogSink } from "~/lib/log.server";
import { clearCampaignModeCache } from "~/lib/metafields.server";
import { clearOrderCache } from "~/lib/orders.server";
import { deriveOutcome } from "~/lib/outcome";
import { verifySpinToken } from "~/lib/spin-token.server";
import { SpinError, executeSpin, getSpinState, getSpinStatus } from "./spin.server";

const BASE_ENV = {
  CAMPAIGN_MODE: "live",
  COLLECTION_CLUBS: "gid://shopify/Collection/11",
  COLLECTION_ACCESSORIES: "gid://shopify/Collection/22",
  COLLECTION_APPAREL: "gid://shopify/Collection/33",
  SPIN_SECRET: "0123456789abcdef0123456789abcdef",
  APP_URL: "https://spin.example.com",
  SPIN_PAGE_URL: "https://www.greenteegolf.ca/pages/spin",
  SHOPIFY_API_KEY: "key",
  SHOPIFY_API_SECRET: "secret",
  SHOP_DOMAIN: "greentee.myshopify.com",
  TEST_EMAILS: "qa@example.com",
};
const NOW = new Date("2026-10-10T18:00:00Z");
const SECRET = BASE_ENV.SPIN_SECRET;

/** First order id (from 1) whose derived slice satisfies the predicate. */
function orderIdWhere(pred: (index: number) => boolean): string {
  for (let id = 1; id < 100_000; id++) {
    if (pred(deriveOutcome(SECRET, id).slice.index)) return String(id);
  }
  throw new Error("no order id found");
}
const DISCOUNT_ORDER = orderIdWhere((i) => i === 1); // 10% clubs
const GIFT_ORDER = orderIdWhere((i) => SLICES[i - 1].rewardType === "gift");

interface RawOrder {
  id: string;
  name: string;
  email: string | null;
  createdAt: string;
  tags: string[];
  currentSubtotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  customer: {
    id: string;
    tags: string[];
    emailMarketingConsent: { marketingState: string } | null;
  } | null;
  metafield: { id: string; value: string } | null;
}

function rawOrder(id: string, over: Partial<RawOrder> = {}): RawOrder {
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${1000 + Number(id)}`,
    email: "buyer@example.com",
    createdAt: NOW.toISOString(),
    tags: [],
    currentSubtotalPriceSet: { shopMoney: { amount: "300.00", currencyCode: "CAD" } },
    customer: { id: "gid://shopify/Customer/1", tags: [], emailMarketingConsent: null },
    metafield: null,
    ...over,
  };
}

/** In-memory stand-in for the Admin API with just enough behaviour for the spin flow. */
class FakeAdmin implements AdminClient {
  orders = new Map<string, RawOrder | null>();
  /** How many times an order lookup should return null before the order appears. */
  notReadyFor = new Map<string, number>();
  discounts = new Map<string, { id: string; title: string }>();
  shopMode: string | null = null;
  calls: Array<{ op: string; vars: Record<string, unknown> }> = [];
  failCreateWith: UserError[] | null = null;
  failMetafieldWrite = false;
  private nextDiscountId = 500;

  async request<T>(_query: string, vars: Record<string, unknown>, ctx: GraphqlContext): Promise<T> {
    this.calls.push({ op: ctx.operation, vars });
    switch (ctx.operation) {
      case "shopCampaignMode":
        return { shop: { metafield: this.shopMode ? { value: this.shopMode } : null } } as T;
      case "order": {
        const id = String(vars.id).split("/").pop()!;
        const left = this.notReadyFor.get(id) ?? 0;
        if (left > 0) {
          this.notReadyFor.set(id, left - 1);
          return { order: null } as T;
        }
        return { order: this.orders.get(id) ?? null } as T;
      }
      case "discountCodeBasicCreate": {
        const input = vars.basicCodeDiscount as { code: string; title: string };
        if (this.failCreateWith) {
          return {
            discountCodeBasicCreate: { codeDiscountNode: null, userErrors: this.failCreateWith },
          } as T;
        }
        if (this.discounts.has(input.code)) {
          return {
            discountCodeBasicCreate: {
              codeDiscountNode: null,
              userErrors: [
                {
                  field: ["basicCodeDiscount", "code"],
                  code: "TAKEN",
                  message: "Code has already been taken",
                },
              ],
            },
          } as T;
        }
        const id = `gid://shopify/DiscountCodeNode/${this.nextDiscountId++}`;
        this.discounts.set(input.code, { id, title: input.title });
        return {
          discountCodeBasicCreate: {
            codeDiscountNode: { id, codeDiscount: { title: input.title } },
            userErrors: [],
          },
        } as T;
      }
      case "codeDiscountNodeByCode": {
        const d = this.discounts.get(String(vars.code));
        return {
          codeDiscountNodeByCode: d
            ? { id: d.id, codeDiscount: { title: d.title, status: "ACTIVE" } }
            : null,
        } as T;
      }
      case "metafieldsSet": {
        if (this.failMetafieldWrite) {
          return {
            metafieldsSet: {
              metafields: null,
              userErrors: [{ field: ["value"], message: "boom" }],
            },
          } as T;
        }
        const [mf] = vars.metafields as Array<{ ownerId: string; value: string }>;
        const id = mf.ownerId.split("/").pop()!;
        const order = this.orders.get(id);
        if (order)
          this.orders.set(id, {
            ...order,
            metafield: { id: "gid://shopify/Metafield/1", value: mf.value },
          });
        return {
          metafieldsSet: { metafields: [{ id: "gid://shopify/Metafield/1" }], userErrors: [] },
        } as T;
      }
      default:
        throw new Error(`unexpected operation ${ctx.operation}`);
    }
  }

  ops(op: string) {
    return this.calls.filter((c) => c.op === op);
  }
}

function deps(admin: FakeAdmin, envOver: Record<string, string> = {}, giftIssuer?: GiftIssuer) {
  const env: AppEnv = loadEnv({ ...BASE_ENV, ...envOver });
  return {
    admin,
    env,
    now: () => NOW,
    giftIssuer,
    fetchOrderOpts: { baseDelayMs: 0, sleep: async () => {} },
  };
}

beforeEach(() => {
  setLogSink(() => {});
  clearOrderCache();
  clearCampaignModeCache();
});
afterEach(() => setLogSink(null));

describe("getSpinStatus", () => {
  it("returns only campaignOpen:false when the mode is off, without touching the order", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    expect(await getSpinStatus(DISCOUNT_ORDER, deps(admin, { CAMPAIGN_MODE: "off" }))).toEqual({
      campaignOpen: false,
    });
    expect(admin.ops("order")).toHaveLength(0);
  });

  it("honours the shop metafield override over the environment", async () => {
    const admin = new FakeAdmin();
    admin.shopMode = "off";
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    expect(await getSpinStatus(DISCOUNT_ORDER, deps(admin, { CAMPAIGN_MODE: "live" }))).toEqual({
      campaignOpen: false,
    });
  });

  it("reports pending while the order is not queryable yet, then resolves", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    admin.notReadyFor.set(DISCOUNT_ORDER, 6); // more than the 4 attempts
    expect(await getSpinStatus(DISCOUNT_ORDER, deps(admin))).toEqual({
      campaignOpen: true,
      pending: true,
    });
    expect(admin.ops("order")).toHaveLength(4);
    // Next poll: the order appears on the 3rd attempt.
    const status = await getSpinStatus(DISCOUNT_ORDER, deps(admin));
    expect(status).toMatchObject({
      campaignOpen: true,
      pending: false,
      eligible: true,
      alreadySpun: false,
    });
  });

  it("returns a signed spin URL for an eligible order", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    const status = await getSpinStatus(DISCOUNT_ORDER, deps(admin));
    expect(status).toMatchObject({ eligible: true, alreadySpun: false, testMode: false });
    const url = new URL((status as { spinUrl: string }).spinUrl);
    expect(url.origin + url.pathname).toBe("https://www.greenteegolf.ca/pages/spin");
    const token = verifySpinToken(SECRET, url.searchParams.get("token"), NOW);
    expect(token).toMatchObject({ ok: true, orderId: DISCOUNT_ORDER });
  });

  it("gives ineligible orders an encouraging message and no spin URL", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(
      DISCOUNT_ORDER,
      rawOrder(DISCOUNT_ORDER, {
        currentSubtotalPriceSet: { shopMoney: { amount: "299.99", currencyCode: "CAD" } },
      }),
    );
    const status = await getSpinStatus(DISCOUNT_ORDER, deps(admin));
    expect(status).toMatchObject({ eligible: false, reason: "below_minimum" });
    expect((status as { message: string }).message).toMatch(/\$300/);
    expect("spinUrl" in status).toBe(false);
  });

  it("hides the wheel from non-testers in test mode", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    expect(await getSpinStatus(DISCOUNT_ORDER, deps(admin, { CAMPAIGN_MODE: "test" }))).toEqual({
      campaignOpen: false,
    });
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER, { tags: ["Test-User"] }));
    clearOrderCache();
    expect(
      await getSpinStatus(DISCOUNT_ORDER, deps(admin, { CAMPAIGN_MODE: "test" })),
    ).toMatchObject({
      eligible: true,
      testMode: true,
    });
  });

  it("caches the order briefly for polling", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    await getSpinStatus(DISCOUNT_ORDER, deps(admin));
    await getSpinStatus(DISCOUNT_ORDER, deps(admin));
    expect(admin.ops("order")).toHaveLength(1);
  });
});

describe("executeSpin: discount reward", () => {
  it("creates the code with the approved discount shape and writes the metafield last", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    const d = deps(admin);
    const outcome = await executeSpin(DISCOUNT_ORDER, {}, d);

    expect(outcome).toMatchObject({
      campaignOpen: true,
      alreadySpun: false,
      forced: false,
      result: {
        sliceIndex: 1,
        rewardKey: "clubs_10",
        rewardType: "discount",
        expired: false,
        testMode: false,
      },
    });
    const code = (outcome as { result: { code: string } }).result.code;
    expect(code).toMatch(/^GT-[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);

    const [create] = admin.ops("discountCodeBasicCreate");
    const input = create.vars.basicCodeDiscount as Record<string, unknown>;
    expect(input).toMatchObject({
      title: `${DISCOUNT_TITLE.prefix} 10% Off Eligible Clubs #${1000 + Number(DISCOUNT_ORDER)}`,
      code,
      usageLimit: 1,
      appliesOncePerCustomer: true,
      customerSelection: { all: true },
      customerGets: {
        value: { percentage: 0.1 },
        items: { collections: { add: ["gid://shopify/Collection/11"] } },
      },
      combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: false },
      endsAt: d.env.campaignEnd.toISOString(),
    });
    expect(input).not.toHaveProperty("minimumRequirement");

    // Order of operations: create discount, then write metafield.
    const ops = admin.calls
      .map((c) => c.op)
      .filter((o) => o !== "shopCampaignMode" && o !== "order");
    expect(ops).toEqual(["discountCodeBasicCreate", "metafieldsSet"]);

    const record = JSON.parse(admin.orders.get(DISCOUNT_ORDER)!.metafield!.value);
    expect(record).toMatchObject({
      version: 1,
      sliceIndex: 1,
      rewardKey: "clubs_10",
      rewardType: "discount",
      code,
      discountNodeId: "gid://shopify/DiscountCodeNode/500",
      gift: null,
      email: "buyer@example.com",
      testMode: false,
      forced: false,
      expiresAt: "2026-11-02T17:00:00.000Z",
    });
    expect(record).not.toHaveProperty("notified");
  });

  it("returns the stored result on a second spin without creating anything", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    const first = await executeSpin(DISCOUNT_ORDER, {}, deps(admin));
    const second = await executeSpin(DISCOUNT_ORDER, {}, deps(admin));
    expect(second).toMatchObject({ alreadySpun: true });
    expect((second as { result: { code: string } }).result.code).toBe(
      (first as { result: { code: string } }).result.code,
    );
    expect(admin.ops("discountCodeBasicCreate")).toHaveLength(1);
    expect(admin.ops("metafieldsSet")).toHaveLength(1);
  });

  it("converges when two requests race: duplicate code is looked up, both write identical records", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    // Both requests read the order before either has written the metafield.
    const [a, b] = await Promise.all([
      executeSpin(DISCOUNT_ORDER, {}, deps(admin)),
      executeSpin(DISCOUNT_ORDER, {}, deps(admin)),
    ]);
    const codeA = (a as { result: { code: string } }).result.code;
    const codeB = (b as { result: { code: string } }).result.code;
    expect(codeA).toBe(codeB);
    expect(admin.discounts.size).toBe(1);
    expect(admin.ops("discountCodeBasicCreate")).toHaveLength(2);
    expect(admin.ops("codeDiscountNodeByCode")).toHaveLength(1);
    const writes = admin
      .ops("metafieldsSet")
      .map((c) => (c.vars.metafields as Array<{ value: string }>)[0].value);
    expect(writes).toHaveLength(2);
    const [w1, w2] = writes.map((v) => JSON.parse(v));
    expect(w1.code).toBe(w2.code);
    expect(w1.discountNodeId).toBe(w2.discountNodeId);
    expect(w1.sliceIndex).toBe(w2.sliceIndex);
  });

  it("refuses to reuse an existing code that belongs to a different reward", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    const code = deriveOutcome(SECRET, DISCOUNT_ORDER).discountCode;
    admin.discounts.set(code, { id: "gid://shopify/DiscountCodeNode/1", title: "Something else" });
    await expect(executeSpin(DISCOUNT_ORDER, {}, deps(admin))).rejects.toMatchObject({
      code: "discount_failed",
      status: 500,
    });
    expect(admin.ops("metafieldsSet")).toHaveLength(0);
  });

  it("surfaces other userErrors as retryable and never writes the metafield", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    admin.failCreateWith = [
      { field: ["basicCodeDiscount", "customerGets"], code: "INVALID", message: "nope" },
    ];
    const err = await executeSpin(DISCOUNT_ORDER, {}, deps(admin)).catch((e) => e);
    expect(err).toBeInstanceOf(SpinError);
    expect(err).toMatchObject({ status: 503, code: "discount_failed", retryable: true });
    expect(admin.ops("metafieldsSet")).toHaveLength(0);
  });

  it("is retryable when the metafield write fails, and the retry reuses the discount", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    admin.failMetafieldWrite = true;
    await expect(executeSpin(DISCOUNT_ORDER, {}, deps(admin))).rejects.toMatchObject({
      code: "record_failed",
      retryable: true,
    });
    admin.failMetafieldWrite = false;
    const retry = await executeSpin(DISCOUNT_ORDER, {}, deps(admin));
    expect(retry).toMatchObject({ alreadySpun: false });
    expect(admin.discounts.size).toBe(1);
    expect(admin.ops("codeDiscountNodeByCode")).toHaveLength(1);
  });
});

describe("executeSpin: gates", () => {
  it("returns the closed state in off mode and for non-testers in test mode", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    expect(await executeSpin(DISCOUNT_ORDER, {}, deps(admin, { CAMPAIGN_MODE: "off" }))).toEqual({
      campaignOpen: false,
    });
    expect(await executeSpin(DISCOUNT_ORDER, {}, deps(admin, { CAMPAIGN_MODE: "test" }))).toEqual({
      campaignOpen: false,
    });
    expect(admin.ops("discountCodeBasicCreate")).toHaveLength(0);
  });

  it("rejects ineligible orders with 409", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(
      DISCOUNT_ORDER,
      rawOrder(DISCOUNT_ORDER, {
        currentSubtotalPriceSet: { shopMoney: { amount: "299.99", currencyCode: "CAD" } },
      }),
    );
    await expect(executeSpin(DISCOUNT_ORDER, {}, deps(admin))).rejects.toMatchObject({
      status: 409,
      code: "not_eligible",
    });
  });

  it("reports a pending order as retryable 503 and never uses the cache", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    await getSpinStatus(DISCOUNT_ORDER, deps(admin)); // warms the cache
    admin.notReadyFor.set(DISCOUNT_ORDER, 10);
    await expect(executeSpin(DISCOUNT_ORDER, {}, deps(admin))).rejects.toMatchObject({
      status: 503,
      code: "order_pending",
    });
  });

  it("shows a stored result as expired after the campaign end", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    await executeSpin(DISCOUNT_ORDER, {}, deps(admin));
    clearOrderCache();
    const later = { ...deps(admin), now: () => new Date("2026-11-03T00:00:00Z") };
    const status = await getSpinStatus(DISCOUNT_ORDER, later);
    expect(status).toMatchObject({ alreadySpun: true, result: { expired: true } });
  });

  it("gift slices fail loudly until issuance is implemented, and write nothing", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(GIFT_ORDER, rawOrder(GIFT_ORDER));
    await expect(executeSpin(GIFT_ORDER, {}, deps(admin))).rejects.toMatchObject({
      status: 503,
      code: "gift_unavailable",
    });
    expect(admin.ops("metafieldsSet")).toHaveLength(0);
    expect(admin.ops("discountCodeBasicCreate")).toHaveLength(0);
  });

  it("records a gift when an issuer is provided", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(GIFT_ORDER, rawOrder(GIFT_ORDER));
    const issuer: GiftIssuer = {
      async issue(input) {
        return {
          variantId: "gid://shopify/ProductVariant/9",
          lineItemId: null,
          orderEditId: null,
          reference: input.giftReference,
        };
      },
    };
    const outcome = await executeSpin(GIFT_ORDER, {}, deps(admin, {}, issuer));
    expect(outcome).toMatchObject({
      result: {
        rewardType: "gift",
        code: null,
        gift: { variantId: "gid://shopify/ProductVariant/9" },
      },
    });
    expect((outcome as { result: { gift: { reference: string } } }).result.gift.reference).toMatch(
      /^GFJ-/,
    );
  });
});

describe("executeSpin: test users and forceSlice", () => {
  it("returns 403 when a non-tester sends forceSlice", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    await expect(executeSpin(DISCOUNT_ORDER, { forceSlice: 3 }, deps(admin))).rejects.toMatchObject(
      { status: 403, code: "force_not_allowed" },
    );
    expect(admin.ops("discountCodeBasicCreate")).toHaveLength(0);
  });

  it("lets a tester force a slice, flags the record, and uses the TEST prefixes", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER, { email: "QA@example.com" }));
    const outcome = await executeSpin(DISCOUNT_ORDER, { forceSlice: "6" }, deps(admin));
    expect(outcome).toMatchObject({
      forced: true,
      result: { sliceIndex: 6, rewardKey: "apparel_30", testMode: true },
    });
    const code = (outcome as { result: { code: string } }).result.code;
    expect(code.startsWith("GT-TEST-")).toBe(true);
    const input = admin.ops("discountCodeBasicCreate")[0].vars.basicCodeDiscount as {
      title: string;
      customerGets: unknown;
    };
    expect(input.title.startsWith(DISCOUNT_TITLE.testPrefix)).toBe(true);
    expect(input.customerGets).toMatchObject({
      value: { percentage: 0.3 },
      items: { collections: { add: ["gid://shopify/Collection/33"] } },
    });
    const record = JSON.parse(admin.orders.get(DISCOUNT_ORDER)!.metafield!.value);
    expect(record).toMatchObject({ testMode: true, forced: true });
  });

  it("rejects forceSlice 10 and out-of-range values with 400", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER, { tags: ["test-user"] }));
    await expect(
      executeSpin(DISCOUNT_ORDER, { forceSlice: 10 }, deps(admin)),
    ).rejects.toMatchObject({ status: 400, code: "invalid_force_slice" });
    await expect(executeSpin(DISCOUNT_ORDER, { forceSlice: 0 }, deps(admin))).rejects.toMatchObject(
      { status: 400 },
    );
    expect(admin.ops("discountCodeBasicCreate")).toHaveLength(0);
  });

  it("bypasses the minimum for testers only when configured", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(
      DISCOUNT_ORDER,
      rawOrder(DISCOUNT_ORDER, {
        tags: ["test-user"],
        currentSubtotalPriceSet: { shopMoney: { amount: "5.00", currencyCode: "CAD" } },
      }),
    );
    await expect(executeSpin(DISCOUNT_ORDER, {}, deps(admin))).rejects.toMatchObject({
      code: "not_eligible",
    });
    const outcome = await executeSpin(
      DISCOUNT_ORDER,
      {},
      deps(admin, { TEST_BYPASS_MIN_SUBTOTAL: "true" }),
    );
    expect(outcome).toMatchObject({ result: { testMode: true } });
  });

  it("cannot mint a code from a stale test link after the campaign has ended", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER, { tags: ["test-user"] }));
    const late = {
      ...deps(admin, { CAMPAIGN_MODE: "test" }),
      now: () => new Date("2026-11-02T17:00:01Z"),
    };
    await expect(executeSpin(DISCOUNT_ORDER, { forceSlice: 1 }, late)).rejects.toMatchObject({
      status: 409,
      code: "not_eligible",
    });
    expect(admin.ops("discountCodeBasicCreate")).toHaveLength(0);
  });

  it("ignores forceSlice once a result exists", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER, { tags: ["test-user"] }));
    await executeSpin(DISCOUNT_ORDER, { forceSlice: 1 }, deps(admin));
    const again = await executeSpin(DISCOUNT_ORDER, { forceSlice: 3 }, deps(admin));
    expect(again).toMatchObject({ alreadySpun: true, result: { sliceIndex: 1 } });
  });
});

describe("getSpinState", () => {
  it("includes the wheel labels from config and no spin URL", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    const state = await getSpinState(DISCOUNT_ORDER, deps(admin));
    expect(state).toMatchObject({ eligible: true });
    expect("spinUrl" in state).toBe(false);
    expect((state as { wheel?: readonly unknown[] }).wheel).toEqual(
      SLICES.map((s) => ({ index: s.index, label: s.label })),
    );
  });
});
