import { describe, expect, it } from "vitest";
import { GIFT_CATALOG } from "~/config/campaign";
import { buildOffer, isAvailable, pickVariant, type VariantStock } from "./gifts.server";

function v(id: string, options: Record<string, string>, qty: number, afs = true): VariantStock {
  return {
    id: `gid://shopify/ProductVariant/${id}`,
    title: Object.values(options).join(" / "),
    availableForSale: afs,
    inventoryQuantity: qty,
    options: Object.fromEntries(Object.entries(options).map(([k, val]) => [k.toLowerCase(), val])),
  };
}

const GLOVES = GIFT_CATALOG.gift_gloves;
const SOCKS = GIFT_CATALOG.gift_socks;

/** Aura gloves: Hand x Size, Colour White only. stock keyed "LH/22". */
function gloves(stock: Record<string, number>): VariantStock[] {
  let n = 1;
  return Object.entries(stock).map(([k, qty]) => {
    const [hand, size] = k.split("/");
    return v(String(n++), { Hand: hand, Size: size, Colour: "White" }, qty);
  });
}

describe("isAvailable", () => {
  it("requires availableForSale and strictly positive inventory", () => {
    expect(isAvailable(v("1", {}, 3))).toBe(true);
    expect(isAvailable(v("1", {}, 0))).toBe(false);
    expect(isAvailable(v("1", {}, -2))).toBe(false); // oversold
    expect(isAvailable(v("1", {}, 5, false))).toBe(false);
  });
});

describe("buildOffer: gloves (Hand and Size, White only)", () => {
  it("lists both options, the in-stock combinations, and preselects the deepest combination", () => {
    const offer = buildOffer(
      GLOVES,
      gloves({ "LH/18": 0, "RH/18": -3, "LH/22": 2, "RH/22": 9, "LH/23": 4, "RH/26": 1 }),
    );
    expect(offer.options).toEqual([
      { name: "Hand", values: ["LH", "RH"] },
      { name: "Size", values: ["18", "22", "23", "26"] },
    ]);
    expect(offer.combinations.map((c) => [c.selection.Hand, c.selection.Size, c.stock])).toEqual([
      ["LH", "22", 2],
      ["RH", "22", 9],
      ["LH", "23", 4],
      ["RH", "26", 1],
    ]);
    // Never a fixed value: the deepest in-stock combination, whatever it is.
    expect(offer.preselect).toEqual({ Hand: "RH", Size: "22" });
    expect(offer.anyAvailable).toBe(true);
    expect(offer.note).not.toMatch(/left hand|random/i);
  });

  it("is unavailable when nothing is in stock", () => {
    const offer = buildOffer(GLOVES, gloves({ "LH/22": 0, "RH/22": -1 }));
    expect(offer.combinations).toEqual([]);
    expect(offer.preselect).toBeNull();
    expect(offer.anyAvailable).toBe(false);
  });
});

describe("buildOffer: socks and brush", () => {
  it("has nothing to choose and reports availability", () => {
    const stock = [
      v("1", { Colour: "Black" }, 0),
      v("2", { Colour: "Beige" }, 4),
      v("3", { Colour: "Navy" }, 1),
    ];
    const offer = buildOffer(SOCKS, stock);
    expect(offer.options).toEqual([]);
    expect(offer.combinations).toEqual([]);
    expect(offer.anyAvailable).toBe(true);
    expect(
      buildOffer(
        SOCKS,
        stock.map((s) => ({ ...s, inventoryQuantity: 0 })),
      ).anyAvailable,
    ).toBe(false);
  });
});

describe("pickVariant", () => {
  it("resolves the exact hand and size for gloves, with no colour logic", () => {
    const r = pickVariant(GLOVES, gloves({ "LH/22": 2, "RH/22": 5 }), { Hand: "RH", Size: "22" });
    expect(r).toMatchObject({ ok: true, variant: { title: "RH / 22 / White" } });
  });

  it("requires every customer option and rejects unknown values", () => {
    const stock = gloves({ "LH/22": 1, "RH/22": 1 });
    expect(pickVariant(GLOVES, stock, null)).toEqual({ ok: false, reason: "selection_required" });
    expect(pickVariant(GLOVES, stock, { Size: "22" })).toEqual({
      ok: false,
      reason: "selection_required",
    });
    expect(pickVariant(GLOVES, stock, { Hand: "LH", Size: "40" })).toEqual({
      ok: false,
      reason: "invalid_selection",
    });
    expect(pickVariant(GLOVES, stock, { Hand: "XX", Size: "22" })).toEqual({
      ok: false,
      reason: "invalid_selection",
    });
  });

  it("reports no stock for a sold-out combination and never substitutes another", () => {
    expect(
      pickVariant(GLOVES, gloves({ "LH/21": 3, "RH/22": 3 }), { Hand: "LH", Size: "22" }),
    ).toEqual({
      ok: false,
      reason: "no_stock",
    });
  });

  it("matches values case-insensitively and accepts lower-cased keys", () => {
    expect(pickVariant(GLOVES, gloves({ "LH/22": 1 }), { hand: "lh", size: "22" })).toMatchObject({
      ok: true,
    });
  });

  it("picks the deepest colour for socks with no selection, ties to the first", () => {
    const stock = [
      v("1", { Colour: "Black" }, 4),
      v("2", { Colour: "Beige" }, 4),
      v("3", { Colour: "Navy" }, 2),
    ];
    expect(pickVariant(SOCKS, stock, null)).toMatchObject({
      ok: true,
      variant: { title: "Black" },
    });
    expect(pickVariant(SOCKS, stock, { Size: "ignored" })).toMatchObject({
      ok: true,
      variant: { title: "Black" },
    });
  });
});
