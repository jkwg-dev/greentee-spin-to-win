import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REWARD_REDIRECTS,
  SHOP_ORIGIN,
  SLICES,
  discountShopUrl,
  rewardShortLabel,
} from "./campaign";

describe("rewardShortLabel", () => {
  it("shortens discounts to '<pct>% off <collection>' and keeps gift names", () => {
    expect(rewardShortLabel("accessories_15")).toBe("15% off accessories");
    expect(rewardShortLabel("clubs_10")).toBe("10% off clubs");
    expect(rewardShortLabel("apparel_30")).toBe("30% off apparel");
    expect(rewardShortLabel("gift_gloves")).toBe("GFJ Gloves");
    expect(rewardShortLabel("nope")).toBe("nope");
  });
});

describe("discountShopUrl", () => {
  it("applies the code and redirects to the reward's collection", () => {
    expect(discountShopUrl("accessories_15", "7K2Q9MXA")).toBe(
      `${SHOP_ORIGIN}/discount/7K2Q9MXA?redirect=%2Fcollections%2Faccessories-regular-priced`,
    );
    expect(discountShopUrl("gift_socks", "X")).toBe(`${SHOP_ORIGIN}/discount/X?redirect=%2F`);
    expect(discountShopUrl("clubs_10", "TEST-AB/CD")).toContain("/discount/TEST-AB%2FCD?");
  });

  it("has a redirect for every discount collection in the table", () => {
    for (const s of SLICES)
      if (s.discount) expect(REWARD_REDIRECTS[s.discount.collection]).toMatch(/^\/collections\//);
  });
});

describe("storefront modal parity", () => {
  // spin-page.js is a plain browser script and cannot import this module, so it
  // carries its own copy of the origin and the redirect paths. Keep them equal.
  const js = fs.readFileSync(
    path.join(__dirname, "../../extensions/spin-wheel/assets/spin-page.js"),
    "utf8",
  );

  it("uses the same shop origin", () => {
    expect(js).toContain(`var SHOP_ORIGIN = "${SHOP_ORIGIN}";`);
  });

  it("uses the same redirect path per reward", () => {
    for (const s of SLICES) {
      if (!s.discount) continue;
      const re = new RegExp(`${s.rewardKey}:\\s*"([^"]+)"`);
      expect(js.match(re)?.[1], s.rewardKey).toBe(REWARD_REDIRECTS[s.discount.collection]);
    }
  });

  it("uses the same primary label", () => {
    expect(js).toContain('var SHOP_LABEL = "Shop with discount";');
  });
});
