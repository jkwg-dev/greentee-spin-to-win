import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DISCOUNT_TITLE, GIFT_CATALOG, GIFT_TAGS, SLICES } from "~/config/campaign";
import { loadEnv, type AppEnv } from "~/config/env.server";
import type { AdminClient, GraphqlContext, UserError } from "~/lib/admin.server";
import { setLogSink, type LogLine } from "~/lib/log.server";
import { clearCampaignModeCache } from "~/lib/metafields.server";
import { clearOrderCache } from "~/lib/orders.server";
import { deriveOutcome } from "~/lib/outcome";
import { verifySpinToken } from "~/lib/spin-token.server";
import { SpinError, confirmGift, executeSpin, getSpinState, getSpinStatus } from "./spin.server";

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
const GLOVE_ORDER = orderIdWhere((i) => SLICES[i - 1].rewardKey === "gift_gloves");
const SOCKS_ORDER = orderIdWhere((i) => SLICES[i - 1].rewardKey === "gift_socks");

interface RawOrder {
  id: string;
  name: string;
  email: string | null;
  createdAt: string;
  tags: string[];
  statusPageUrl: string | null;
  currentSubtotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  metafield: { id: string; value: string } | null;
}

interface RawVariant {
  id: string;
  title: string;
  inventoryQuantity: number;
  availableForSale?: boolean;
  options: Record<string, string>;
}

interface RawLine {
  id: string;
  variantId: string;
  productId: string;
  original: string;
  discounted: string;
}

/** LH gloves in three colours for the given sizes: size -> [BLACK, CAMO1, CAMO2] stock. */
function gloveVariants(stock: Record<string, [number, number, number]>): RawVariant[] {
  const out: RawVariant[] = [];
  let n = 1;
  for (const [size, s] of Object.entries(stock)) {
    for (const [i, color] of ["BLACK", "CAMO1(BLUE)", "CAMO2(ORANGE)"].entries()) {
      out.push({
        id: `gid://shopify/ProductVariant/g${n++}`,
        title: `LH / ${color} / ${size}`,
        inventoryQuantity: s[i],
        options: { Hand: "LH", Color: color, Size: size },
      });
    }
  }
  return out;
}

function sockVariants(stock: Record<string, number>): RawVariant[] {
  return Object.entries(stock).map(([colour, qty], i) => ({
    id: `gid://shopify/ProductVariant/s${i + 1}`,
    title: colour,
    inventoryQuantity: qty,
    options: { Colour: colour },
  }));
}

function rawOrder(id: string, over: Partial<RawOrder> = {}): RawOrder {
  return {
    id: `gid://shopify/Order/${id}`,
    name: `#${1000 + Number(id)}`,
    email: "buyer@example.com",
    createdAt: NOW.toISOString(),
    tags: [],
    statusPageUrl: `https://greentee.myshopify.com/orders/tok${id}`,
    currentSubtotalPriceSet: { shopMoney: { amount: "300.00", currencyCode: "CAD" } },
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
  /** Gift products: productId -> variants. */
  products = new Map<string, RawVariant[]>();
  /** Committed line items per order id. */
  lines = new Map<string, RawLine[]>();
  /** Staged variant per calculated order id. */
  private edits = new Map<
    string,
    { orderId: string; variantId: string | null; discounted: boolean }
  >();
  private nextEdit = 900;
  /** Make one order-edit mutation fail with userErrors. */
  failEditAt: string | null = null;

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
      case "giftProduct": {
        const variants = this.products.get(String(vars.id));
        if (!variants) return { product: null } as T;
        return {
          product: {
            id: vars.id,
            title: "Product",
            featuredImage: { url: "https://cdn.example/gift.jpg" },
            variants: {
              nodes: variants.map((v) => ({
                id: v.id,
                title: v.title,
                availableForSale: v.availableForSale ?? true,
                inventoryQuantity: v.inventoryQuantity,
                selectedOptions: Object.entries(v.options).map(([name, value]) => ({
                  name,
                  value,
                })),
              })),
            },
          },
        } as T;
      }
      case "orderLines": {
        const id = String(vars.id).split("/").pop()!;
        return {
          order: {
            lineItems: {
              nodes: (this.lines.get(id) ?? []).map((l) => ({
                id: l.id,
                quantity: 1,
                variant: { id: l.variantId, product: { id: l.productId } },
                originalTotalSet: { shopMoney: { amount: l.original } },
                discountedTotalSet: { shopMoney: { amount: l.discounted } },
              })),
            },
          },
        } as T;
      }
      case "orderEditBegin": {
        if (this.failEditAt === "orderEditBegin")
          return {
            orderEditBegin: {
              calculatedOrder: null,
              userErrors: [{ field: ["id"], message: "nope" }],
            },
          } as T;
        const calcId = `gid://shopify/CalculatedOrder/${this.nextEdit++}`;
        this.edits.set(calcId, {
          orderId: String(vars.id).split("/").pop()!,
          variantId: null,
          discounted: false,
        });
        return { orderEditBegin: { calculatedOrder: { id: calcId }, userErrors: [] } } as T;
      }
      case "orderEditAddVariant": {
        if (this.failEditAt === "orderEditAddVariant")
          return {
            orderEditAddVariant: {
              calculatedLineItem: null,
              userErrors: [{ field: ["variantId"], message: "nope" }],
            },
          } as T;
        const edit = this.edits.get(String(vars.id))!;
        edit.variantId = String(vars.variantId);
        return {
          orderEditAddVariant: {
            calculatedLineItem: { id: "gid://shopify/CalculatedLineItem/1" },
            userErrors: [],
          },
        } as T;
      }
      case "orderEditAddLineItemDiscount": {
        const edit = this.edits.get(String(vars.id))!;
        const discount = vars.discount as { percentValue: number };
        edit.discounted = discount.percentValue === 100;
        return {
          orderEditAddLineItemDiscount: { addedDiscountStagedChange: { id: "x" }, userErrors: [] },
        } as T;
      }
      case "orderEditCommit": {
        if (this.failEditAt === "orderEditCommit")
          return {
            orderEditCommit: { order: null, userErrors: [{ field: ["id"], message: "nope" }] },
          } as T;
        const edit = this.edits.get(String(vars.id))!;
        const productId =
          [...this.products.entries()].find(([, vs]) =>
            vs.some((v) => v.id === edit.variantId),
          )?.[0] ?? "";
        const lines = this.lines.get(edit.orderId) ?? [];
        lines.push({
          id: `gid://shopify/LineItem/${100 + lines.length}`,
          variantId: edit.variantId!,
          productId,
          original: "39.99",
          discounted: edit.discounted ? "0.0" : "39.99",
        });
        this.lines.set(edit.orderId, lines);
        return {
          orderEditCommit: { order: { id: `gid://shopify/Order/${edit.orderId}` }, userErrors: [] },
        } as T;
      }
      case "tagsAdd":
      case "tagsRemove": {
        const id = String(vars.id).split("/").pop()!;
        const order = this.orders.get(id);
        if (order) {
          const tags = vars.tags as string[];
          const next =
            ctx.operation === "tagsAdd"
              ? [...new Set([...order.tags, ...tags])]
              : order.tags.filter((t) => !tags.includes(t));
          this.orders.set(id, { ...order, tags: next });
        }
        return { [ctx.operation]: { userErrors: [] } } as T;
      }
      default:
        throw new Error(`unexpected operation ${ctx.operation}`);
    }
  }

  ops(op: string) {
    return this.calls.filter((c) => c.op === op);
  }
}

function deps(admin: FakeAdmin, envOver: Record<string, string> = {}) {
  const env: AppEnv = loadEnv({ ...BASE_ENV, ...envOver });
  return {
    admin,
    env,
    now: () => NOW,
    fetchOrderOpts: { baseDelayMs: 0, sleep: async () => {} },
  };
}

let logLines: LogLine[] = [];

beforeEach(() => {
  logLines = [];
  setLogSink((line) => logLines.push(line));
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

  it("a gift win records pending and tags the order before any order edit", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(GLOVE_ORDER, rawOrder(GLOVE_ORDER));
    admin.products.set(
      GIFT_CATALOG.gift_gloves.productId,
      gloveVariants({ "22": [2, 5, 1], "23": [0, -4, 0] }),
    );
    const outcome = await executeSpin(GLOVE_ORDER, {}, deps(admin));
    expect(outcome).toMatchObject({
      result: { rewardType: "gift", code: null, gift: { status: "pending" } },
      giftOffer: {
        customerOption: "Size",
        preselect: "22",
        anyAvailable: true,
        imageUrl: "https://cdn.example/gift.jpg",
      },
    });
    const offer = (outcome as unknown as { giftOffer: { choices: unknown[] } }).giftOffer;
    expect(offer.choices).toEqual([
      { value: "22", available: true, stock: 8 },
      { value: "23", available: false, stock: 0 },
    ]);
    const ops = admin.calls
      .map((c) => c.op)
      .filter((o) => !["shopCampaignMode", "order"].includes(o));
    expect(ops).toEqual(["metafieldsSet", "tagsAdd", "giftProduct"]);
    expect(admin.orders.get(GLOVE_ORDER)!.tags).toContain(GIFT_TAGS.pending);
    const record = JSON.parse(admin.orders.get(GLOVE_ORDER)!.metafield!.value);
    expect(record.gift).toMatchObject({
      status: "pending",
      productId: GIFT_CATALOG.gift_gloves.productId,
      variantId: null,
    });
    expect(record.gift.reference).toMatch(/^GFJ-/);
  });
});

describe("executeSpin: test users and forceSlice", () => {
  it("returns 403 when a non-tester sends forceSlice", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    await expect(executeSpin(DISCOUNT_ORDER, { forceSlice: 3 }, deps(admin))).rejects.toMatchObject(
      { status: 403, code: "force_not_allowed" },
    );
    // Nothing written anywhere: no discount, no metafield, and the order is still unspun.
    expect(admin.ops("discountCodeBasicCreate")).toHaveLength(0);
    expect(admin.ops("metafieldsSet")).toHaveLength(0);
    expect(admin.orders.get(DISCOUNT_ORDER)!.metafield).toBeNull();
    // A normal spin afterwards still works.
    const normal = await executeSpin(DISCOUNT_ORDER, {}, deps(admin));
    expect(normal).toMatchObject({ alreadySpun: false, forced: false, result: { sliceIndex: 1 } });
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

  it("rejects forceSlice 10 (no such slice) and out-of-range values with 400", async () => {
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
  it("includes the odds and chip labels derived from the reward table", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    const state = await getSpinState(DISCOUNT_ORDER, deps(admin));
    expect(state).toMatchObject({
      odds: { discountPercent: 75, giftPercent: 25 },
      rewardTypeLabels: { discount: "Discount", gift: "Free gift" },
    });
  });

  it("includes the order status URL for the back button", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    const state = await getSpinState(DISCOUNT_ORDER, deps(admin));
    expect((state as { orderUrl?: string }).orderUrl).toBe(
      `https://greentee.myshopify.com/orders/tok${DISCOUNT_ORDER}`,
    );
  });

  it("includes the wheel labels from config and no spin URL", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    const state = await getSpinState(DISCOUNT_ORDER, deps(admin));
    expect(state).toMatchObject({ eligible: true });
    expect("spinUrl" in state).toBe(false);
    expect((state as { wheel?: readonly unknown[] }).wheel).toEqual(
      SLICES.map((s) => ({
        index: s.index,
        label: s.wheelLabel,
        icon: s.icon,
        rewardType: s.rewardType,
        typeLabel: s.rewardType === "gift" ? "Free gift" : "Discount",
      })),
    );
  });
});

describe("confirmGift", () => {
  function gloveOrder(stock: Record<string, [number, number, number]>) {
    const admin = new FakeAdmin();
    admin.orders.set(GLOVE_ORDER, rawOrder(GLOVE_ORDER));
    admin.products.set(GIFT_CATALOG.gift_gloves.productId, gloveVariants(stock));
    return admin;
  }

  it("adds the chosen size in the colour with most stock at 100% off, then flips the tag", async () => {
    const admin = gloveOrder({ "22": [2, 5, 1] });
    await executeSpin(GLOVE_ORDER, {}, deps(admin));
    admin.calls.length = 0;

    const done = await confirmGift(GLOVE_ORDER, { selection: { Size: "22" } }, deps(admin));
    expect(done).toMatchObject({
      result: {
        gift: { status: "added", variantTitle: "LH / CAMO1(BLUE) / 22", selection: { Size: "22" } },
      },
      giftOffer: null,
    });

    const ops = admin.calls
      .map((c) => c.op)
      .filter((o) => !["shopCampaignMode", "order"].includes(o));
    expect(ops).toEqual([
      "orderLines", // idempotency check first
      "giftProduct",
      "orderEditBegin",
      "orderEditAddVariant",
      "orderEditAddLineItemDiscount",
      "orderEditCommit",
      "orderLines", // read back the committed line
      "metafieldsSet",
      "tagsAdd",
      "tagsRemove",
    ]);
    const discount = admin.ops("orderEditAddLineItemDiscount")[0].vars.discount;
    expect(discount).toEqual({ percentValue: 100, description: "Spin to Win gift" });
    expect(admin.ops("orderEditCommit")[0].vars.staffNote).toMatch(/^Spin to Win gift GFJ-/);

    const record = JSON.parse(admin.orders.get(GLOVE_ORDER)!.metafield!.value);
    expect(record.gift).toMatchObject({
      status: "added",
      variantId: "gid://shopify/ProductVariant/g2",
      lineItemId: "gid://shopify/LineItem/100",
      orderEditId: "gid://shopify/CalculatedOrder/900",
    });
    expect(admin.orders.get(GLOVE_ORDER)!.tags).toEqual([GIFT_TAGS.added]);
  });

  it("adds socks immediately with no selection, picking the deepest colour", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(SOCKS_ORDER, rawOrder(SOCKS_ORDER));
    admin.products.set(
      GIFT_CATALOG.gift_socks.productId,
      sockVariants({ Black: 1, Beige: 6, Navy: 3 }),
    );
    const spun = await executeSpin(SOCKS_ORDER, {}, deps(admin));
    expect(spun).toMatchObject({
      giftOffer: { customerOption: null, choices: null, anyAvailable: true },
    });
    const done = await confirmGift(SOCKS_ORDER, {}, deps(admin));
    expect(done.result.gift).toMatchObject({ status: "added", variantTitle: "Beige" });
  });

  it("does not edit the order when every colour of the chosen size is out of stock or oversold", async () => {
    const admin = gloveOrder({ "22": [0, -3, 0], "23": [4, 0, 0] });
    await executeSpin(GLOVE_ORDER, {}, deps(admin));
    admin.calls.length = 0;
    const done = await confirmGift(GLOVE_ORDER, { selection: { Size: "22" } }, deps(admin));
    expect(done).toMatchObject({
      result: { gift: { status: "unavailable" } },
      message: expect.stringMatching(/contact us/i),
    });
    expect(admin.ops("orderEditBegin")).toHaveLength(0);
    expect(admin.orders.get(GLOVE_ORDER)!.tags).toEqual([GIFT_TAGS.pending]);
    const record = JSON.parse(admin.orders.get(GLOVE_ORDER)!.metafield!.value);
    expect(record.gift.reason).toMatch(/no_stock for {"Size":"22"}/);
    // Never substitutes: size 23 was in stock and was not used.
    expect(admin.lines.get(GLOVE_ORDER) ?? []).toHaveLength(0);
    // Stock comes back: a retry adds it.
    admin.products.set(GIFT_CATALOG.gift_gloves.productId, gloveVariants({ "22": [1, 0, 0] }));
    const retry = await confirmGift(GLOVE_ORDER, { selection: { Size: "22" } }, deps(admin));
    expect(retry.result.gift).toMatchObject({ status: "added", variantTitle: "LH / BLACK / 22" });
  });

  it("requires a size for gloves and rejects an unknown size", async () => {
    const admin = gloveOrder({ "22": [1, 1, 1] });
    await executeSpin(GLOVE_ORDER, {}, deps(admin));
    await expect(confirmGift(GLOVE_ORDER, {}, deps(admin))).rejects.toMatchObject({
      status: 400,
      code: "selection_required",
    });
    await expect(
      confirmGift(GLOVE_ORDER, { selection: { Size: "99" } }, deps(admin)),
    ).rejects.toMatchObject({
      status: 400,
      code: "invalid_selection",
    });
    expect(admin.ops("orderEditBegin")).toHaveLength(0);
  });

  it("is idempotent: a second confirm returns the added gift without another edit", async () => {
    const admin = gloveOrder({ "22": [1, 1, 1] });
    await executeSpin(GLOVE_ORDER, {}, deps(admin));
    await confirmGift(GLOVE_ORDER, { selection: { Size: "22" } }, deps(admin));
    admin.calls.length = 0;
    const again = await confirmGift(GLOVE_ORDER, { selection: { Size: "22" } }, deps(admin));
    expect(again.result.gift).toMatchObject({ status: "added" });
    expect(admin.ops("orderEditBegin")).toHaveLength(0);
    expect(admin.lines.get(GLOVE_ORDER)).toHaveLength(1);
  });

  it("adopts a gift line that is already on the order (crash after commit) instead of adding another", async () => {
    const admin = gloveOrder({ "22": [1, 1, 1] });
    await executeSpin(GLOVE_ORDER, {}, deps(admin));
    admin.lines.set(GLOVE_ORDER, [
      {
        id: "gid://shopify/LineItem/77",
        variantId: "gid://shopify/ProductVariant/g1",
        productId: GIFT_CATALOG.gift_gloves.productId,
        original: "39.99",
        discounted: "0.0",
      },
    ]);
    const done = await confirmGift(GLOVE_ORDER, { selection: { Size: "22" } }, deps(admin));
    expect(done.result.gift).toMatchObject({ status: "added" });
    expect(admin.ops("orderEditBegin")).toHaveLength(0);
    const record = JSON.parse(admin.orders.get(GLOVE_ORDER)!.metafield!.value);
    expect(record.gift).toMatchObject({
      lineItemId: "gid://shopify/LineItem/77",
      variantId: "gid://shopify/ProductVariant/g1",
    });
    expect(admin.orders.get(GLOVE_ORDER)!.tags).toEqual([GIFT_TAGS.added]);
  });

  it("leaves the record pending and the tag in place when the order edit fails, so a retry is safe", async () => {
    const admin = gloveOrder({ "22": [1, 1, 1] });
    await executeSpin(GLOVE_ORDER, {}, deps(admin));
    admin.failEditAt = "orderEditCommit";
    await expect(
      confirmGift(GLOVE_ORDER, { selection: { Size: "22" } }, deps(admin)),
    ).rejects.toMatchObject({
      status: 503,
      code: "gift_edit_failed",
      retryable: true,
    });
    const record = JSON.parse(admin.orders.get(GLOVE_ORDER)!.metafield!.value);
    expect(record.gift.status).toBe("pending");
    expect(admin.orders.get(GLOVE_ORDER)!.tags).toEqual([GIFT_TAGS.pending]);
    admin.failEditAt = null;
    const retry = await confirmGift(GLOVE_ORDER, { selection: { Size: "22" } }, deps(admin));
    expect(retry.result.gift?.status).toBe("added");
  });

  it("refuses to confirm on an unspun order or a discount win", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    await expect(confirmGift(DISCOUNT_ORDER, {}, deps(admin))).rejects.toMatchObject({
      status: 409,
      code: "not_spun",
    });
    await executeSpin(DISCOUNT_ORDER, {}, deps(admin));
    await expect(confirmGift(DISCOUNT_ORDER, {}, deps(admin))).rejects.toMatchObject({
      status: 409,
      code: "not_a_gift",
    });
  });

  it("keeps the Thank you page link alive for a pending gift and drops it once added", async () => {
    const admin = gloveOrder({ "22": [1, 1, 1] });
    await executeSpin(GLOVE_ORDER, {}, deps(admin));
    clearOrderCache();
    const pending = await getSpinStatus(GLOVE_ORDER, deps(admin));
    expect(pending).toMatchObject({ alreadySpun: true, result: { gift: { status: "pending" } } });
    expect(typeof (pending as { spinUrl?: string }).spinUrl).toBe("string");
    const state = await getSpinState(GLOVE_ORDER, deps(admin));
    expect((state as { giftOffer?: unknown }).giftOffer).toMatchObject({ customerOption: "Size" });

    await confirmGift(GLOVE_ORDER, { selection: { Size: "22" } }, deps(admin));
    clearOrderCache();
    const added = await getSpinStatus(GLOVE_ORDER, deps(admin));
    expect(added).toMatchObject({ alreadySpun: true, result: { gift: { status: "added" } } });
    expect("spinUrl" in added).toBe(false);
  });
});

describe("logging: one order ID tells the whole story", () => {
  const story = (id: string) => logLines.filter((l) => l.orderId === id).map((l) => l.event);

  it("covers eligibility, outcome, discount creation, metafield write and completion for a discount spin", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    await getSpinStatus(DISCOUNT_ORDER, deps(admin));
    await executeSpin(DISCOUNT_ORDER, {}, deps(admin));
    const events = story(DISCOUNT_ORDER);
    for (const expected of [
      "spin.eligibility",
      "spin.status",
      "spin.execute.outcome",
      "discount.created",
      "metafield.written",
      "spin.execute.done",
    ]) {
      expect(events).toContain(expected);
    }
    const elig = logLines.find(
      (l) => l.event === "spin.eligibility" && l.orderId === DISCOUNT_ORDER,
    )!;
    expect(elig).toMatchObject({
      decision: "eligible",
      subtotal: 300,
      minSubtotal: 300,
      mode: "live",
      isTestUser: false,
    });
    const outcome = logLines.find((l) => l.event === "spin.execute.outcome")!;
    expect(outcome).toMatchObject({ sliceIndex: 1, rewardKey: "clubs_10", forced: false });
    expect(typeof outcome.discountCode).toBe("string");
    // Every line about this order carries its ID.
    expect(
      logLines
        .filter(
          (l) =>
            l.event.startsWith("spin.") ||
            l.event.startsWith("discount.") ||
            l.event.startsWith("metafield."),
        )
        .every((l) => l.orderId === DISCOUNT_ORDER),
    ).toBe(true);
  });

  it("covers the gift path through confirmation and records why an ineligible order was refused", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(GLOVE_ORDER, rawOrder(GLOVE_ORDER));
    admin.products.set(GIFT_CATALOG.gift_gloves.productId, gloveVariants({ "22": [1, 4, 0] }));
    await executeSpin(GLOVE_ORDER, {}, deps(admin));
    await confirmGift(GLOVE_ORDER, { selection: { Size: "22" } }, deps(admin));
    const events = story(GLOVE_ORDER);
    for (const expected of [
      "spin.eligibility",
      "spin.execute.outcome",
      "metafield.written",
      "spin.execute.done",
      "gift.added",
      "gift.confirm.done",
    ]) {
      expect(events).toContain(expected);
    }
    expect(logLines.find((l) => l.event === "gift.confirm.done")).toMatchObject({
      orderId: GLOVE_ORDER,
      selection: { Size: "22" },
    });

    const cheap = "77777";
    admin.orders.set(
      cheap,
      rawOrder(cheap, {
        currentSubtotalPriceSet: { shopMoney: { amount: "299.99", currencyCode: "CAD" } },
      }),
    );
    await expect(executeSpin(cheap, {}, deps(admin))).rejects.toMatchObject({
      code: "not_eligible",
    });
    expect(
      logLines.find((l) => l.event === "spin.eligibility" && l.orderId === cheap),
    ).toMatchObject({ decision: "below_minimum", subtotal: 299.99 });
  });

  it("logs Shopify userErrors from a failed discount creation against the order", async () => {
    const admin = new FakeAdmin();
    admin.orders.set(DISCOUNT_ORDER, rawOrder(DISCOUNT_ORDER));
    admin.failCreateWith = [
      { field: ["basicCodeDiscount", "customerGets"], code: "INVALID", message: "nope" },
    ];
    await expect(executeSpin(DISCOUNT_ORDER, {}, deps(admin))).rejects.toMatchObject({
      code: "discount_failed",
    });
    const failed = logLines.find((l) => l.event === "discount.create.failed")!;
    expect(failed).toMatchObject({ orderId: DISCOUNT_ORDER, level: "error" });
    expect(failed.userErrors).toEqual([
      { field: ["basicCodeDiscount", "customerGets"], code: "INVALID", message: "nope" },
    ]);
  });
});
