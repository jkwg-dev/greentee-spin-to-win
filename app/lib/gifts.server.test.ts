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

/** LH gloves: sizes 18..25 x BLACK / CAMO1(BLUE) / CAMO2(ORANGE). */
function gloves(stock: Record<string, [number, number, number]>): VariantStock[] {
  const out: VariantStock[] = [];
  let n = 1;
  for (const size of ["18", "19", "20", "21", "22", "23", "24", "25"]) {
    const s = stock[size] ?? [0, 0, 0];
    out.push(v(String(n++), { Hand: "LH", Color: "BLACK", Size: size }, s[0]));
    out.push(v(String(n++), { Hand: "LH", Color: "CAMO1(BLUE)", Size: size }, s[1]));
    out.push(v(String(n++), { Hand: "LH", Color: "CAMO2(ORANGE)", Size: size }, s[2]));
  }
  return out;
}

describe("isAvailable", () => {
  it("requires availableForSale and strictly positive inventory", () => {
    expect(isAvailable(v("1", {}, 3))).toBe(true);
    expect(isAvailable(v("1", {}, 0))).toBe(false);
    expect(isAvailable(v("1", {}, -2))).toBe(false); // oversold
    expect(isAvailable(v("1", {}, 5, false))).toBe(false);
  });
});

describe("buildOffer: gloves", () => {
  it("lists sizes in numeric order, disables sizes with no colour in stock, preselects the deepest size", () => {
    const offer = buildOffer(
      GLOVES,
      gloves({
        "18": [0, 0, 0],
        "19": [-3, 0, 0],
        "22": [2, 5, 1],
        "23": [9, 0, 0],
        "25": [0, 1, 0],
      }),
    );
    expect(offer.customerOption).toBe("Size");
    expect(offer.choices!.map((c) => c.value)).toEqual([
      "18",
      "19",
      "20",
      "21",
      "22",
      "23",
      "24",
      "25",
    ]);
    expect(offer.choices!.filter((c) => c.available).map((c) => c.value)).toEqual([
      "22",
      "23",
      "25",
    ]);
    expect(offer.preselect).toBe("23"); // 9 > 8 > 1
    expect(offer.anyAvailable).toBe(true);
    expect(offer.note).toMatch(/Left hand \(LH\)/);
    expect(offer.note).toMatch(/randomly selected/i);
  });

  it("ignores variants that are not left hand", () => {
    const rh = v("99", { Hand: "RH", Color: "BLACK", Size: "22" }, 50);
    const offer = buildOffer(GLOVES, [rh, ...gloves({})]);
    expect(offer.anyAvailable).toBe(false);
    expect(offer.preselect).toBeNull();
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
    expect(offer.customerOption).toBeNull();
    expect(offer.choices).toBeNull();
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
  it("picks the colour with the most stock in the chosen size", () => {
    const r = pickVariant(GLOVES, gloves({ "22": [2, 5, 1] }), { Size: "22" });
    expect(r).toMatchObject({ ok: true, variant: { title: "LH / CAMO1(BLUE) / 22" } });
  });

  it("never picks an oversold or unpublished colour even if its number is largest", () => {
    const stock = gloves({ "22": [1, 0, 0] });
    const oversold = stock.find((s) => s.title === "LH / CAMO2(ORANGE) / 22")!;
    (oversold as { inventoryQuantity: number }).inventoryQuantity = -7;
    const r = pickVariant(GLOVES, stock, { Size: "22" });
    expect(r).toMatchObject({ ok: true, variant: { title: "LH / BLACK / 22" } });
  });

  it("reports no stock for a sold-out size, and never substitutes another size", () => {
    expect(pickVariant(GLOVES, gloves({ "21": [3, 3, 3] }), { Size: "22" })).toEqual({
      ok: false,
      reason: "no_stock",
    });
  });

  it("requires a size for gloves and rejects an unknown one", () => {
    expect(pickVariant(GLOVES, gloves({ "22": [1, 1, 1] }), null)).toEqual({
      ok: false,
      reason: "selection_required",
    });
    expect(pickVariant(GLOVES, gloves({ "22": [1, 1, 1] }), { Size: "40" })).toEqual({
      ok: false,
      reason: "invalid_selection",
    });
  });

  it("matches the size case-insensitively and accepts a lower-cased key", () => {
    expect(pickVariant(GLOVES, gloves({ "22": [1, 1, 1] }), { size: "22" })).toMatchObject({
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
