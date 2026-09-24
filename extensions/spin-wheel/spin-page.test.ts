// @vitest-environment jsdom
/**
 * Behavioural tests for assets/spin-page.js, run against the block's own
 * markup in jsdom with a fake wheel and a fake app proxy.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const SCRIPT = fs.readFileSync(path.join(DIR, "assets/spin-page.js"), "utf8");
const LIQUID = fs.readFileSync(path.join(DIR, "blocks/spin-wheel.liquid"), "utf8");

/** The block markup with Liquid stripped and defaults resolved, like the harness does. */
function blockMarkup(): string {
  let block = LIQUID.split("{{ 'spin-page.css'")[0];
  block = block.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/, "");
  block = block.replace(/\{%-?\s*liquid[\s\S]*?-?%\}/, "");
  return block
    .replace(/\{\{ block\.settings\.(\w+) \| default: '([^']*)' \| escape \}\}/g, "$2")
    .replace(/\{\{ block\.settings\.(\w+) \| default: '([^']*)' \}\}/g, "$2")
    .replace(/\{\{ block\.settings\.intro \| escape \}\}/g, "Intro copy")
    .replace(/\{\{ block\.settings\.heading \| escape \}\}/g, "Spin to Win")
    .replace(/\{\{ block\.settings\.eyebrow \| escape \}\}/g, "Eyebrow")
    .replace(/\{\{ block\.settings\.overlay \}\}/g, "true")
    .replace(/\{%-?[\s\S]*?-?%\}/g, "")
    .replace(/\{\{[\s\S]*?\}\}/g, "");
}

interface WheelCall {
  m: string;
  a: unknown[];
}

const TYPE = (t: string) => (t === "gift" ? "Free gift" : "Discount");
const WHEEL_BASE = [
  { index: 1, label: "10% Off Clubs", icon: "club", rewardType: "discount" },
  { index: 2, label: "GFJ Gloves", icon: "glove", rewardType: "gift" },
  { index: 3, label: "15% Off Accessories", icon: "bag", rewardType: "discount" },
  { index: 4, label: "GFJ Club Brush", icon: "brush", rewardType: "gift" },
  { index: 5, label: "GFJ Socks", icon: "sock", rewardType: "gift" },
  { index: 6, label: "30% Off Apparel", icon: "shirt", rewardType: "discount" },
  { index: 7, label: "GFJ Gloves", icon: "glove", rewardType: "gift" },
  { index: 8, label: "GFJ Club Brush", icon: "brush", rewardType: "gift" },
  { index: 9, label: "GFJ Socks", icon: "sock", rewardType: "gift" },
];
const WHEEL = WHEEL_BASE.map((w) => ({ ...w, typeLabel: TYPE(w.rewardType) }));

const RESULT = {
  sliceIndex: 3,
  rewardKey: "accessories_15",
  rewardLabel: "15% Off Eligible Accessories",
  rewardType: "discount",
  code: "7K2Q9MXA",
  gift: null,
  spunAt: "2026-10-03T18:22:41.000Z",
  expiresAt: "2026-11-02T17:00:00.000Z",
  expired: false,
  testMode: false,
};

const ELIGIBLE = {
  campaignOpen: true,
  pending: false,
  alreadySpun: false,
  eligible: true,
  testMode: false,
  wheel: WHEEL,
  orderUrl: "https://shop.example/orders/1",
  odds: { discountPercent: 75, giftPercent: 25 },
  rewardTypeLabels: { discount: "Discount", gift: "Free gift" },
};

type Reply = { status: number; body: unknown };

interface Mount {
  url: string;
  state: Reply | ((n: number) => Reply);
  execute?: Reply | ((body: Record<string, unknown>, n: number) => Reply);
  gift?: Reply | ((body: Record<string, unknown>, n: number) => Reply);
}

interface Page {
  calls: WheelCall[];
  executeBodies: Record<string, unknown>[];
  giftBodies: Record<string, unknown>[];
  fetches: string[];
  el: (sel: string) => HTMLElement;
  status: () => string;
  wheel: () => FakeWheel | null;
}

class FakeWheel {
  static last: FakeWheel | null = null;
  items: unknown[];
  rotation = 0;
  rotationSpeed = 0;
  onRest: (() => void) | null;
  constructor(_container: HTMLElement, props: { items: unknown[]; onRest?: () => void }) {
    this.items = props.items;
    this.onRest = props.onRest ?? null;
    FakeWheel.last = this;
  }
  spin(speed: number) {
    calls.push({ m: "spin", a: [speed] });
    this.rotationSpeed = speed;
  }
  spinToItem(...a: unknown[]) {
    calls.push({ m: "spinToItem", a });
    const duration = a[1] as number;
    this.rotation = (a[0] as number) * 36;
    if (duration > 0) setTimeout(() => this.onRest && this.onRest(), 5);
  }
  stop() {
    calls.push({ m: "stop", a: [] });
    this.rotationSpeed = 0;
  }
  getCurrentIndex() {
    return Math.round(this.rotation / 36);
  }
}

let calls: WheelCall[] = [];

function flush(ms = 30): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function mount(opts: Mount): Promise<Page> {
  calls = [];
  FakeWheel.last = null;
  document.documentElement.className = "";
  document.body.innerHTML = blockMarkup();
  window.history.replaceState(null, "", opts.url);
  (globalThis as unknown as { spinWheel: unknown }).spinWheel = { Wheel: FakeWheel };
  if (!("requestAnimationFrame" in window)) {
    (
      window as unknown as { requestAnimationFrame: (cb: () => void) => number }
    ).requestAnimationFrame = () => 0;
  }
  const executeBodies: Record<string, unknown>[] = [];
  const giftBodies: Record<string, unknown>[] = [];
  const fetches: string[] = [];
  let stateCalls = 0;
  let executeCalls = 0;
  let giftCalls = 0;
  vi.stubGlobal("fetch", async (url: string, init?: RequestInit) => {
    fetches.push(url);
    let reply: Reply;
    if (url.includes("/state")) {
      reply = typeof opts.state === "function" ? opts.state(stateCalls++) : opts.state;
    } else if (url.includes("/execute")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      executeBodies.push(body);
      const ex = opts.execute ?? {
        status: 200,
        body: { campaignOpen: true, alreadySpun: false, forced: false, result: RESULT },
      };
      reply = typeof ex === "function" ? ex(body, executeCalls++) : ex;
    } else if (url.includes("/gift")) {
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      giftBodies.push(body);
      const g = opts.gift ?? { status: 404, body: {} };
      reply = typeof g === "function" ? g(body, giftCalls++) : g;
    } else {
      reply = { status: 404, body: {} };
    }
    return new Response(JSON.stringify(reply.body), {
      status: reply.status,
      headers: { "content-type": "application/json" },
    });
  });
  (0, eval)(SCRIPT);
  await flush();
  return {
    calls,
    executeBodies,
    giftBodies,
    fetches,
    el: (sel) => document.querySelector(sel) as HTMLElement,
    status: () => (document.querySelector("[data-status]") as HTMLElement).textContent ?? "",
    wheel: () => FakeWheel.last,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("spin page: token gate", () => {
  it("shows a plain message and nothing else without a token", async () => {
    const p = await mount({ url: "/pages/spin-to-win", state: { status: 200, body: ELIGIBLE } });
    expect(p.status()).toMatch(/invalid or has expired/);
    expect(p.el("[data-stage]").hidden).toBe(true);
    expect(p.el("[data-spin]").hidden).toBe(true);
    expect(p.el("[data-retry]").hidden).toBe(true);
    expect(p.fetches).toHaveLength(0);
    expect(p.wheel()).toBeNull();
  });

  it("shows the same plain message when the server rejects the token", async () => {
    const p = await mount({
      url: "/pages/spin-to-win?token=bad",
      state: { status: 401, body: { error: "invalid_token" } },
    });
    expect(p.status()).toMatch(/invalid or has expired/);
    expect(p.el("[data-stage]").hidden).toBe(true);
    expect(p.wheel()).toBeNull();
  });

  it("locks the page as an overlay", async () => {
    await mount({ url: "/pages/spin-to-win?token=ok", state: { status: 200, body: ELIGIBLE } });
    expect(document.documentElement.classList.contains("gt-spin-open")).toBe(true);
  });
});

describe("spin page: forcing an outcome from the URL", () => {
  it("surfaces a 403 as a plain error with a safe retry, never a stuck wheel", async () => {
    const p = await mount({
      url: "/pages/spin-to-win?token=ok&force=5",
      state: { status: 200, body: ELIGIBLE },
      execute: (body) =>
        body.forceSlice !== undefined
          ? {
              status: 403,
              body: {
                error: "force_not_allowed",
                message: "forceSlice is only available to test users",
              },
            }
          : {
              status: 200,
              body: { campaignOpen: true, alreadySpun: false, forced: false, result: RESULT },
            },
    });
    expect(p.el("[data-spin]").hidden).toBe(false);

    p.el("[data-spin]").click();
    await flush();

    // The forced attempt went out, was refused, and the wheel was stopped.
    expect(p.executeBodies[0]).toEqual({ token: "ok", forceSlice: "5" });
    expect(p.calls.map((c) => c.m)).toEqual(["spin", "stop"]);
    expect(p.wheel()!.rotationSpeed).toBe(0);
    expect(p.status()).toBe("That option isn't available. Press Try again to spin.");
    expect(p.el("[data-status]").classList.contains("gt-spin__status--error")).toBe(true);
    expect(p.el("[data-retry]").hidden).toBe(false);
    expect(p.el("[data-spin]").hidden).toBe(true);
    expect(p.el("[data-result]").hidden).toBe(true);

    // Try again spins normally: no forceSlice, lands on the server's slice, shows the result.
    p.el("[data-retry]").click();
    await flush();
    expect(p.executeBodies[1]).toEqual({ token: "ok" });
    const land = p.calls.find((c) => c.m === "spinToItem");
    expect(land?.a).toEqual([2, 5200, true, 4, 1]);
    expect(p.el("[data-result]").hidden).toBe(false);
    expect(p.el("[data-result]").textContent).toContain("7K2Q9MXA");
    expect(p.el("[data-retry]").hidden).toBe(true);
  });
});

describe("spin page: spin and results", () => {
  it("animates to the server's slice and renders the result with a back button", async () => {
    const p = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: { status: 200, body: ELIGIBLE },
    });
    expect(p.status()).toBe("Intro copy");
    expect(document.querySelectorAll(".gt-spin__label")).toHaveLength(9);
    p.el("[data-spin]").click();
    await flush();
    expect(p.calls.map((c) => c.m)).toEqual(["spin", "spinToItem"]);
    expect(p.calls[1].a).toEqual([2, 5200, true, 4, 1]);
    const result = p.el("[data-result]");
    expect(result.hidden).toBe(false);
    expect(result.textContent).toContain("You won 15% Off Eligible Accessories!");
    expect(result.textContent).toContain("order confirmation email");
    expect(result.querySelector("a.gt-spin__back")?.getAttribute("href")).toBe(
      "https://shop.example/orders/1",
    );
    expect(p.el("[data-spin]").hidden).toBe(true);
  });

  it("shows a stored result on load without spinning", async () => {
    const p = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: { status: 200, body: { ...ELIGIBLE, alreadySpun: true, result: RESULT } },
    });
    expect(p.fetches.filter((u) => u.includes("execute"))).toHaveLength(0);
    expect(p.calls).toEqual([{ m: "spinToItem", a: [2, 0, true, 0, 1] }]);
    expect(p.el("[data-result]").hidden).toBe(false);
    expect(p.el("[data-spin]").hidden).toBe(true);
  });

  it("clamps a stored slice index from an older, larger reward table", async () => {
    // Records written before the Try Again slice was removed can carry index 10.
    // The reward label and code are authoritative; the wheel must still settle
    // on a real slice rather than throw or spin forever.
    const stale = { ...RESULT, sliceIndex: 10 };
    const p = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: { status: 200, body: { ...ELIGIBLE, alreadySpun: true, result: stale } },
    });
    expect(p.calls).toEqual([{ m: "spinToItem", a: [8, 0, true, 0, 1] }]);
    expect(p.el("[data-result]").textContent).toContain("7K2Q9MXA");
  });

  it("stops the wheel and offers a retry when execute fails", async () => {
    let n = 0;
    const p = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: { status: 200, body: ELIGIBLE },
      execute: () =>
        n++ === 0
          ? { status: 503, body: { error: "discount_failed", retryable: true } }
          : {
              status: 200,
              body: { campaignOpen: true, alreadySpun: false, forced: false, result: RESULT },
            },
    });
    p.el("[data-spin]").click();
    await flush();
    expect(p.calls.map((c) => c.m)).toEqual(["spin", "stop"]);
    expect(p.status()).toMatch(/Nothing was lost/);
    expect(p.el("[data-retry]").hidden).toBe(false);
    p.el("[data-retry]").click();
    await flush();
    expect(p.executeBodies).toHaveLength(2);
    expect(p.el("[data-result]").hidden).toBe(false);
  });

  it("shows the closed state and the ineligible message", async () => {
    const closed = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: { status: 200, body: { campaignOpen: false } },
    });
    expect(closed.status()).toMatch(/closed right now/);
    expect(closed.el("[data-stage]").hidden).toBe(true);
    const inel = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: {
        status: 200,
        body: { ...ELIGIBLE, eligible: false, reason: "below_minimum", message: "Next time!" },
      },
    });
    expect(inel.status()).toBe("Next time!");
    expect(inel.el("[data-spin]").hidden).toBe(true);
  });
});

const GIFT_RESULT = {
  ...RESULT,
  sliceIndex: 2,
  rewardKey: "gift_gloves",
  rewardLabel: "GFJ Gloves",
  rewardType: "gift",
  code: null,
  gift: { status: "pending", variantTitle: null, selection: null },
};

const GLOVE_OFFER = {
  rewardKey: "gift_gloves",
  productTitle: "GFJ Classic Glove (Unisex)",
  note: "Left hand (LH). Colour is randomly selected.",
  customerOption: "Size",
  choices: [
    { value: "21", available: false, stock: 0 },
    { value: "22", available: true, stock: 8 },
    { value: "23", available: true, stock: 9 },
  ],
  preselect: "23",
  anyAvailable: true,
  imageUrl: "https://cdn.example/glove.jpg",
};

describe("spin page: gifts", () => {
  it("shows the size step for a pending glove, disables sold-out sizes, and confirms the chosen size", async () => {
    const p = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: {
        status: 200,
        body: { ...ELIGIBLE, alreadySpun: true, result: GIFT_RESULT, giftOffer: GLOVE_OFFER },
      },
      gift: (body) => ({
        status: 200,
        body: {
          campaignOpen: true,
          result: {
            ...GIFT_RESULT,
            gift: {
              status: "added",
              variantTitle: `LH / BLACK / ${(body.selection as { Size: string }).Size}`,
              selection: body.selection,
            },
          },
          giftOffer: null,
        },
      }),
    });
    const box = p.el("[data-result]");
    expect(box.hidden).toBe(false);
    expect(box.textContent).toContain("Left hand (LH). Colour is randomly selected.");
    // The card leads with the gift: image, name, chips, one primary button; back link is quiet.
    expect(box.querySelector("img.gt-spin__gift-image")?.getAttribute("src")).toBe(
      "https://cdn.example/glove.jpg",
    );
    const at = (cls: string) => [...box.children].findIndex((c) => c.classList.contains(cls));
    expect(at("gt-spin__gift-image")).toBeLessThan(at("gt-spin__result-heading"));
    expect(at("gt-spin__choices")).toBeLessThan(at("gt-spin__gift-confirm"));
    expect(box.querySelectorAll(".gt-spin__button")).toHaveLength(1);
    expect(box.querySelector("a.gt-spin__back")?.className).toContain("gt-spin__back--quiet");
    const chips = [...box.querySelectorAll<HTMLButtonElement>(".gt-spin__chip")];
    expect(chips.map((c) => c.textContent)).toEqual(["21", "22", "23"]);
    expect(chips[0].disabled).toBe(true);
    expect(chips[2].getAttribute("aria-checked")).toBe("true");

    chips[1].click();
    expect(chips[1].getAttribute("aria-checked")).toBe("true");
    box.querySelector<HTMLButtonElement>(".gt-spin__gift-confirm")!.click();
    await flush();

    expect(p.giftBodies).toEqual([{ token: "ok", selection: { Size: "22" } }]);
    expect(box.textContent).toContain("Added to your order: GFJ Gloves (LH / BLACK / 22).");
    expect(box.querySelector(".gt-spin__gift-confirm")).toBeNull();
    // Once added, the back action becomes the visible button again.
    expect(box.querySelector("a.gt-spin__back")?.className).toContain("gt-spin__button");
    expect(box.querySelector("a.gt-spin__back")?.className).not.toContain("quiet");
  });

  it("confirms socks with no selection step", async () => {
    const socks = { ...GIFT_RESULT, rewardKey: "gift_socks", rewardLabel: "GFJ Socks" };
    const offer = {
      ...GLOVE_OFFER,
      rewardKey: "gift_socks",
      customerOption: null,
      choices: null,
      preselect: null,
      note: "Colour is randomly selected.",
    };
    const p = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: {
        status: 200,
        body: { ...ELIGIBLE, alreadySpun: true, result: socks, giftOffer: offer },
      },
      gift: {
        status: 200,
        body: {
          campaignOpen: true,
          result: { ...socks, gift: { status: "added", variantTitle: "Beige", selection: null } },
          giftOffer: null,
        },
      },
    });
    const box = p.el("[data-result]");
    expect(box.querySelectorAll(".gt-spin__chip")).toHaveLength(0);
    box.querySelector<HTMLButtonElement>(".gt-spin__gift-confirm")!.click();
    await flush();
    expect(p.giftBodies).toEqual([{ token: "ok" }]);
    expect(box.textContent).toContain("Added to your order: GFJ Socks (Beige).");
  });

  it("shows the out-of-stock message and no confirm button when nothing is available", async () => {
    const p = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: {
        status: 200,
        body: {
          ...ELIGIBLE,
          alreadySpun: true,
          result: GIFT_RESULT,
          giftOffer: { ...GLOVE_OFFER, anyAvailable: false, preselect: null },
        },
      },
    });
    const box = p.el("[data-result]");
    expect(box.textContent).toMatch(/Contact us/);
    expect(box.querySelector(".gt-spin__gift-confirm")).toBeNull();
  });

  it("keeps the confirm button usable after a failed order edit", async () => {
    let n = 0;
    const p = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: {
        status: 200,
        body: { ...ELIGIBLE, alreadySpun: true, result: GIFT_RESULT, giftOffer: GLOVE_OFFER },
      },
      gift: () =>
        n++ === 0
          ? { status: 503, body: { error: "gift_edit_failed", message: "x", retryable: true } }
          : {
              status: 200,
              body: {
                campaignOpen: true,
                result: {
                  ...GIFT_RESULT,
                  gift: {
                    status: "added",
                    variantTitle: "LH / BLACK / 23",
                    selection: { Size: "23" },
                  },
                },
                giftOffer: null,
              },
            },
    });
    const box = p.el("[data-result]");
    const confirm = box.querySelector<HTMLButtonElement>(".gt-spin__gift-confirm")!;
    confirm.click();
    await flush();
    expect(confirm.disabled).toBe(false);
    expect(box.textContent).toMatch(/Nothing was lost/);
    confirm.click();
    await flush();
    expect(p.giftBodies).toHaveLength(2);
    expect(box.textContent).toContain("Added to your order");
  });

  it("renders the gift step right after a gift spin", async () => {
    const p = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: { status: 200, body: ELIGIBLE },
      execute: {
        status: 200,
        body: {
          campaignOpen: true,
          alreadySpun: false,
          forced: false,
          result: GIFT_RESULT,
          giftOffer: GLOVE_OFFER,
        },
      },
    });
    p.el("[data-spin]").click();
    await flush();
    expect(p.el("[data-result]").querySelectorAll(".gt-spin__chip")).toHaveLength(3);
  });
});

describe("spin page: colour, chips, odds and overlay", () => {
  const CREAM = "#efe9dc";
  const NAVY = "#1b2a3d";
  const GREEN = "#2e5a3e";

  it("colours discounts cream and alternates navy/green across gifts so no two touch", async () => {
    const p = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: { status: 200, body: ELIGIBLE },
    });
    const items = p.wheel()!.items as Array<{ backgroundColor: string }>;
    const bgs = items.map((i) => i.backgroundColor.toLowerCase());
    WHEEL.forEach((w, i) => {
      if (w.rewardType === "discount") expect(bgs[i]).toBe(CREAM);
      else expect([NAVY, GREEN]).toContain(bgs[i]);
    });
    for (let i = 1; i < bgs.length; i++) {
      if (WHEEL[i].rewardType === "gift" && WHEEL[i - 1].rewardType === "gift") {
        expect(bgs[i]).not.toBe(bgs[i - 1]);
      }
    }
    // Label text contrasts with its slice: navy on cream, cream on navy/green.
    const labels = [...document.querySelectorAll<HTMLElement>(".gt-spin__label")];
    labels.forEach((l, i) => {
      const expected = bgs[i] === CREAM ? NAVY : CREAM;
      expect(l.style.color.replace(/\s/g, "")).toBe(hexToRgb(expected));
    });
  });

  it("puts a reward-type badge on the outer edge of every slice, outside the label", async () => {
    await mount({ url: "/pages/spin-to-win?token=ok", state: { status: 200, body: ELIGIBLE } });
    const tags = [...document.querySelectorAll<HTMLElement>("[data-labels] .gt-spin__tag--arc")];
    expect(tags.map((c) => c.textContent)).toEqual(WHEEL.map((w) => w.typeLabel));
    expect(document.querySelectorAll(".gt-spin__label .gt-spin__tag")).toHaveLength(0);
    // Further from the centre than the label at the same angle.
    const labels = [...document.querySelectorAll<HTMLElement>(".gt-spin__label")];
    const dist = (e: HTMLElement) =>
      Math.hypot(parseFloat(e.style.left) - 50, parseFloat(e.style.top) - 50);
    tags.forEach((t, i) => expect(dist(t)).toBeGreaterThan(dist(labels[i])));
  });

  it("shows the reward-type chip on the result card", async () => {
    const p = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: { status: 200, body: ELIGIBLE },
    });
    p.el("[data-spin]").click();
    await flush();
    expect(p.el("[data-result]").querySelector(".gt-spin__tag--result")?.textContent).toBe(
      "Discount",
    );
    const gift = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: {
        status: 200,
        body: { ...ELIGIBLE, alreadySpun: true, result: GIFT_RESULT, giftOffer: GLOVE_OFFER },
      },
    });
    expect(gift.el("[data-result]").querySelector(".gt-spin__tag--result")?.textContent).toBe(
      "Free gift",
    );
  });

  it("renders the odds from the server, never from the markup", async () => {
    const p = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: { status: 200, body: { ...ELIGIBLE, odds: { discountPercent: 60, giftPercent: 40 } } },
    });
    expect(p.el("[data-odds]").hidden).toBe(false);
    expect(p.el("[data-odds-line]").textContent).toBe(
      "Odds: a 60% chance of a discount code and a 40% chance of a complimentary GFJ gift.",
    );
    expect(p.el("[data-odds]").textContent).toContain("do not represent the actual chances");
  });

  it("moves the overlay to <body> and locks scroll, so a transformed theme section cannot trap it", async () => {
    const p = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: { status: 200, body: ELIGIBLE },
    });
    const root = p.el("[data-gt-spin]");
    expect(root.parentElement).toBe(document.body);
    expect(document.documentElement.classList.contains("gt-spin-open")).toBe(true);
  });

  it("points the close control at the order's own status page", async () => {
    const p = await mount({
      url: "/pages/spin-to-win?token=ok",
      state: { status: 200, body: ELIGIBLE },
    });
    const close = p.el("[data-close]") as HTMLAnchorElement;
    expect(close.hidden).toBe(false);
    expect(close.getAttribute("href")).toBe("https://shop.example/orders/1");
  });
});

function hexToRgb(hex: string): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255})`;
}
