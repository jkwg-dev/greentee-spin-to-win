// @vitest-environment jsdom
/**
 * Behavioural tests for assets/cart-progress.js against the block's own
 * markup in jsdom, with a fake app proxy and a fake cart.
 */
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const DIR = path.dirname(new URL(import.meta.url).pathname);
const SCRIPT = fs.readFileSync(path.join(DIR, "assets/cart-progress.js"), "utf8");
const LIQUID = fs.readFileSync(path.join(DIR, "blocks/cart-progress.liquid"), "utf8");

/** The element as the theme renders it for a cart with `subtotal` minor units. */
function blockMarkup(subtotal: number, currency = "CAD"): string {
  const start = LIQUID.indexOf("<gt-cart-progress");
  const end = LIQUID.indexOf("</gt-cart-progress>") + "</gt-cart-progress>".length;
  return LIQUID.slice(start, end)
    .replace(/\{\{ block\.settings\.(\w+) \| default: '([^']*)' \| escape \}\}/g, "$2")
    .replace("{{ cart.total_price }}", String(subtotal))
    .replace("{{ cart_currency }}", currency)
    .replace("{{ request.locale.iso_code }}", "en")
    .replace(/\{%-?[\s\S]*?-?%\}/g, "")
    .replace(/\{\{[\s\S]*?\}\}/g, "");
}

interface Fake {
  campaign: { status: number; body: unknown };
  cart: { total_price: number; currency: string };
  campaignCalls: number;
  cartCalls: number;
}

let fake: Fake;
let scriptRan = false;
let clock = Date.now();

// One fetch stub for the whole file: the script wraps window.fetch once, at
// first connect, so the stub underneath must stay put. It reads `fake`, which
// each test replaces.
function installFetch() {
  if ((globalThis as { __gtswFetchStubbed?: boolean }).__gtswFetchStubbed) return;
  (globalThis as { __gtswFetchStubbed?: boolean }).__gtswFetchStubbed = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.url;
      const respond = (status: number, body: unknown) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (url.endsWith("/apps/spin/campaign")) {
        fake.campaignCalls++;
        return respond(fake.campaign.status, fake.campaign.body);
      }
      if (url === "/cart.js") {
        fake.cartCalls++;
        return respond(200, fake.cart);
      }
      if (/\/cart\/(change|add|update)\.js/.test(url)) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { total?: number };
        if (typeof body.total === "number") fake.cart = { ...fake.cart, total_price: body.total };
        return respond(200, fake.cart);
      }
      return respond(404, {});
    }),
  );
}

/** The bar's UI lives in its shadow root. */
function ui(el: Element): ParentNode {
  return el.shadowRoot ?? el;
}

async function flush(ms = 20): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

function mount(subtotal: number, currency = "CAD"): HTMLElement {
  document.body.innerHTML = `<div id="cart">${blockMarkup(subtotal, currency)}</div>`;
  if (!scriptRan) {
    new Function(SCRIPT)();
    scriptRan = true;
  }
  return document.querySelector("gt-cart-progress") as HTMLElement;
}

const OPEN = { open: true, minSubtotal: 300, currency: "CAD" };

beforeEach(() => {
  // A fresh minute: the script caches the campaign answer for 60s in memory and sessionStorage.
  vi.useFakeTimers({ toFake: ["Date"] });
  clock += 120_000;
  vi.setSystemTime(new Date(clock));
  sessionStorage.clear();
  fake = {
    campaign: { status: 200, body: OPEN },
    cart: { total_price: 12345, currency: "CAD" },
    campaignCalls: 0,
    cartCalls: 0,
  };
  installFetch();
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

describe("cart progress: what it shows", () => {
  it("stays hidden until the campaign answers open, then shows the shortfall", async () => {
    const el = mount(12345);
    expect(el.hidden).toBe(true);
    await flush();
    expect(el.hidden).toBe(false);
    expect(ui(el).querySelector("[data-line]")?.textContent).toBe(
      "Add $176.55 more to unlock a wheel spin",
    );
    expect(el.classList.contains("gt-cartbar--reached")).toBe(false);
    // The amount is bold; the pill is one line.
    expect(ui(el).querySelector("[data-line] strong")?.textContent).toBe("$176.55");
    expect(ui(el).querySelector("[data-pill]")?.getAttribute("data-icon")).toBe("true");
    expect(ui(el).querySelector("[data-pill] svg")).not.toBeNull();
    expect(el.style.getPropertyValue("--gtsw-margin")).toBe("12px");
  });

  it("says the spin is unlocked at exactly the threshold and above", async () => {
    const el = mount(30000);
    await flush();
    expect(ui(el).querySelector("[data-line]")?.textContent).toBe(
      "Wheel spin unlocked. Take it after checkout.",
    );
    expect(el.classList.contains("gt-cartbar--reached")).toBe(true);
    const over = mount(45000);
    await flush();
    expect(over.classList.contains("gt-cartbar--reached")).toBe(true);
  });

  it("formats a whole-dollar shortfall without cents", async () => {
    const el = mount(25000);
    await flush();
    expect(ui(el).querySelector("[data-line]")?.textContent).toBe(
      "Add $50 more to unlock a wheel spin",
    );
  });

  it("uses the server's threshold, not a literal", async () => {
    fake.campaign.body = { ...OPEN, minSubtotal: 250 };
    const el = mount(20000);
    await flush();
    expect(ui(el).querySelector("[data-line]")?.textContent).toContain("$50 more");
  });
});

describe("cart progress: when it shows", () => {
  it("renders nothing when the campaign is closed", async () => {
    fake.campaign.body = { ...OPEN, open: false };
    const el = mount(40000);
    await flush();
    expect(el.hidden).toBe(true);
    expect(ui(el).querySelector("[data-line]")?.textContent).toBe("");
  });

  it("renders nothing when the campaign endpoint fails or is malformed", async () => {
    fake.campaign = { status: 500, body: { error: "x" } };
    let el = mount(40000);
    await flush();
    expect(el.hidden).toBe(true);
    clock += 120_000;
    vi.setSystemTime(new Date(clock));
    fake.campaign = { status: 200, body: { open: true } }; // no threshold
    el = mount(40000);
    await flush();
    expect(el.hidden).toBe(true);
  });

  it("renders nothing when the cart is in another currency than the threshold", async () => {
    const el = mount(40000, "USD");
    await flush();
    expect(el.hidden).toBe(true);
  });

  it("asks the campaign endpoint once per minute, not once per render", async () => {
    mount(1000);
    await flush();
    mount(2000);
    await flush();
    expect(fake.campaignCalls).toBe(1);
    clock += 61_000;
    vi.setSystemTime(new Date(clock));
    mount(3000);
    await flush();
    expect(fake.campaignCalls).toBe(2);
  });
});

describe("cart progress: keeping up with the cart", () => {
  it("re-reads /cart.js after a cart change request and updates in place", async () => {
    const el = mount(12345);
    await flush();
    await fetch("/cart/change.js", { method: "POST", body: JSON.stringify({ total: 31000 }) });
    await flush();
    expect(fake.cartCalls).toBe(1);
    expect(ui(el).querySelector("[data-line]")?.textContent).toBe(
      "Wheel spin unlocked. Take it after checkout.",
    );
    await fetch("/cart/change.js", { method: "POST", body: JSON.stringify({ total: 9900 }) });
    await flush();
    expect(ui(el).querySelector("[data-line]")?.textContent).toBe(
      "Add $201 more to unlock a wheel spin",
    );
  });

  it("also notices cart changes made through XMLHttpRequest", async () => {
    const el = mount(12345);
    await flush();
    fake.cart.total_price = 36000;
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/cart/add.js");
    xhr.dispatchEvent(new Event("loadend"));
    await flush();
    expect(fake.cartCalls).toBe(1);
    expect(el.classList.contains("gt-cartbar--reached")).toBe(true);
  });

  it("sets itself up again when the drawer re-renders it with a new cart", async () => {
    mount(12345);
    await flush();
    // The theme swaps the drawer's HTML for a fresh render carrying the new subtotal.
    document.getElementById("cart")!.innerHTML = blockMarkup(29000);
    const again = document.querySelector("gt-cart-progress") as HTMLElement;
    await flush();
    expect(again.hidden).toBe(false);
    expect(ui(again).querySelector("[data-line]")?.textContent).toBe(
      "Add $10 more to unlock a wheel spin",
    );
    expect(fake.campaignCalls).toBe(1); // cached answer, no second round trip
  });

  it("keeps two copies (page and drawer) in step", async () => {
    document.body.innerHTML = `<div id="cart">${blockMarkup(5000)}</div><div id="drawer">${blockMarkup(5000)}</div>`;
    if (!scriptRan) {
      new Function(SCRIPT)();
      scriptRan = true;
    }
    await flush();
    await fetch("/cart/change.js", { method: "POST", body: JSON.stringify({ total: 30000 }) });
    await flush();
    const lines = [...document.querySelectorAll("gt-cart-progress")].map(
      (b) => ui(b).querySelector("[data-line]")?.textContent,
    );
    expect(lines).toEqual([
      "Wheel spin unlocked. Take it after checkout.",
      "Wheel spin unlocked. Take it after checkout.",
    ]);
  });
});

describe("cart progress: theme editor preview", () => {
  function mountPreview(subtotal: number): HTMLElement {
    document.body.innerHTML = `<div id="cart">${blockMarkup(subtotal).replace('data-preview=""', 'data-preview="true"')}</div>`;
    if (!scriptRan) {
      new Function(SCRIPT)();
      scriptRan = true;
    }
    return document.querySelector("gt-cart-progress") as HTMLElement;
  }

  it("shows in design mode even when the campaign is closed and the cart is empty", async () => {
    fake.campaign.body = { ...OPEN, open: false, minSubtotal: 250 };
    const el = mountPreview(0);
    await flush();
    expect(el.hidden).toBe(false);
    // The server's threshold is used when it answers, campaign open or not.
    expect(ui(el).querySelector("[data-line]")?.textContent).toBe(
      "Add $250 more to unlock a wheel spin",
    );
  });

  it("still shows in design mode when the campaign endpoint is unreachable", async () => {
    fake.campaign = { status: 500, body: {} };
    const el = mountPreview(12345);
    await flush();
    expect(el.hidden).toBe(false);
    expect(ui(el).querySelector("[data-line]")?.textContent).toContain("$176.55");
  });

  it("is only a preview: the Liquid flag comes from request.design_mode, in both blocks", () => {
    const EMBED = fs.readFileSync(path.join(DIR, "blocks/cart-progress-embed.liquid"), "utf8");
    for (const src of [LIQUID, EMBED]) {
      expect(src).toMatch(/if request\.design_mode\s+assign preview_flag = 'true'/);
      expect(src).toContain('data-preview="{{ preview_flag }}"');
    }
  });
});

describe("cart progress: live-site preview query", () => {
  it("?spin-embed=test shows the bar for the session, ?spin-embed=off ends it", async () => {
    fake.campaign.body = { ...OPEN, open: false };
    window.history.replaceState(null, "", "/cart?spin-embed=test");
    let el = mount(12345);
    await flush();
    expect(el.hidden).toBe(false);
    expect(ui(el).querySelector("[data-line]")?.textContent).toContain("$176.55");
    // Sticks across navigation within the session.
    window.history.replaceState(null, "", "/collections/all");
    el = mount(12345);
    await flush();
    expect(el.hidden).toBe(false);
    window.history.replaceState(null, "", "/cart?spin-embed=off");
    el = mount(12345);
    await flush();
    expect(el.hidden).toBe(true);
    window.history.replaceState(null, "", "/cart");
  });
});

describe("cart progress: empty cart", () => {
  it("shows nothing for an empty cart", async () => {
    const el = mount(0);
    await flush();
    expect(el.hidden).toBe(true);
  });
});

describe("cart progress: app embed", () => {
  const EMBED = fs.readFileSync(path.join(DIR, "blocks/cart-progress-embed.liquid"), "utf8");
  // Re-running the script on a fresh "page": skip the once-only guard and the
  // element registration (already defined for this window), keep the embed setup.
  const NO_GUARD = SCRIPT.replace(
    'if (window.customElements.get("gt-cart-progress")) return;',
    "",
  ).replace('window.customElements.define("gt-cart-progress", CartProgress);', "");
  function embedMarkup(
    drawerSel = "cart-drawer .cart-drawer__top",
    pageSel = "cart-items .cart__head",
  ) {
    const start = EMBED.indexOf("<template");
    const end = EMBED.indexOf("</template>") + "</template>".length;
    return EMBED.slice(start, end)
      .replace(/\{\{ block\.settings\.(\w+) \| default: '([^']*)' \| escape \}\}/g, "$2")
      .replace("{{ block.settings.drawer_target | escape }}", drawerSel)
      .replace("{{ block.settings.drawer_place }}", "append")
      .replace("{{ block.settings.page_target | escape }}", pageSel)
      .replace("{{ block.settings.page_place }}", "after")
      .replace("{{ cart_currency }}", "CAD")
      .replace("{{ request.locale.iso_code }}", "en")
      .replace(/\{%-?[\s\S]*?-?%\}/g, "")
      .replace(/\{\{[\s\S]*?\}\}/g, "");
  }
  /** The script sets the embed up once per page load; each test is a fresh page, so re-run it. */
  function mountEmbed(): void {
    document.body.innerHTML =
      `<cart-drawer><div class="cart-drawer__inner"><div class="cart-drawer__head"><p>Your cart</p></div><div class="cart-drawer__top"></div><div class="cart-drawer__body">items</div></div></cart-drawer>` +
      `<cart-items><div class="container"><div class="cart__head">Cart</div><form action="/cart">form</form></div></cart-items>` +
      embedMarkup();
    new Function(scriptRan ? NO_GUARD : SCRIPT)();
    scriptRan = true;
  }

  it("injects one bar inside the drawer's top slot and one after the cart page head, reading /cart.js", async () => {
    mountEmbed();
    await flush(40);
    const bars = [...document.querySelectorAll("gt-cart-progress")];
    expect(bars).toHaveLength(2);
    expect(bars[0].parentElement?.className).toBe("cart-drawer__top");
    expect(bars[1].previousElementSibling?.className).toBe("cart__head");
    for (const b of bars) {
      expect(b.hidden).toBe(false);
      expect(ui(b).querySelector("[data-line]")?.textContent).toBe(
        "Add $176.55 more to unlock a wheel spin",
      );
    }
  });

  it("re-injects when the theme replaces the drawer's contents, without duplicating", async () => {
    mountEmbed();
    await flush(40);
    const drawer = document.querySelector("cart-drawer")!;
    drawer.innerHTML = `<div class="cart-drawer__inner"><div class="cart-drawer__head"><p>Your cart</p></div><div class="cart-drawer__top"></div><div class="cart-drawer__body">items</div></div>`;
    await flush(60);
    const inDrawer = drawer.querySelectorAll("gt-cart-progress");
    expect(inDrawer).toHaveLength(1);
    expect(inDrawer[0].parentElement?.className).toBe("cart-drawer__top");
    // A second, unrelated DOM change must not add another copy.
    document.body.appendChild(document.createElement("div"));
    await flush(60);
    expect(drawer.querySelectorAll("gt-cart-progress")).toHaveLength(1);
    expect(document.querySelectorAll("gt-cart-progress")).toHaveLength(2);
  });

  it("ignores a blank or invalid selector", async () => {
    document.body.innerHTML = `<div class="x"></div>` + embedMarkup("", ">>bad");
    new Function(NO_GUARD)();
    await flush(40);
    expect(document.querySelectorAll("gt-cart-progress")).toHaveLength(0);
  });
});

describe("cart progress: block markup", () => {
  it("renders nothing at all in off or test mode, in another currency, or with tax-inclusive prices", () => {
    // The Liquid gates decide `show` before the element; the element renders only when it is true.
    const gate = LIQUID.indexOf("{%- if show -%}");
    expect(gate).toBeGreaterThan(-1);
    expect(LIQUID.indexOf("<gt-cart-progress")).toBeGreaterThan(gate);
    expect(LIQUID).toMatch(/elsif mode == 'off' or mode == 'test'\s+assign show = false/);
    expect(LIQUID).toMatch(
      /elsif cart_currency != shop\.currency or cart\.taxes_included\s+assign show = false/,
    );
  });

  it("reads the cart total after discounts, the same basis as spin eligibility", () => {
    expect(LIQUID).toContain('data-subtotal="{{ cart.total_price }}"');
    expect(SCRIPT).toContain("body.total_price");
  });

  it("never promises a reward, only a spin", () => {
    const copy = [...LIQUID.matchAll(/"default": "([^"]+)"/g)].map((m) => m[1]).join(" ");
    expect(copy.toLowerCase()).not.toMatch(/win a|free gift|discount code|prize|guarantee|reward/);
    expect(copy).toContain("wheel spin");
    // Short enough for one line in a narrow drawer.
    for (const line of [...LIQUID.matchAll(/"default": "(Add|Wheel)[^"]*"/g)].map((m) => m[0]))
      expect(line.length).toBeLessThan(60);
  });
});
