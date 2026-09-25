/**
 * Single source of truth for the Spin to Win campaign.
 *
 * Everything that CLAUDE.md calls "config" and that does not come from the
 * environment lives here: the reward table, the campaign window defaults, the
 * eligibility threshold default, code formats, and the metafield definition.
 * Nothing else in the codebase may duplicate these literals.
 */

export const CAMPAIGN_TIMEZONE = "America/Vancouver";

/**
 * Defaults for values that the environment may override. Wall-clock times are
 * interpreted in CAMPAIGN_TIMEZONE (see env.server.ts and lib/time.ts).
 */
export const CAMPAIGN_DEFAULTS = {
  start: "2026-10-01T00:00:00",
  end: "2026-11-02T09:00:00",
  minSubtotalCad: 300,
  testTag: "test-user",
} as const;

export const CAMPAIGN_MODES = ["off", "test", "live"] as const;
export type CampaignMode = (typeof CAMPAIGN_MODES)[number];

export type RewardKey =
  "clubs_10" | "accessories_15" | "apparel_30" | "gift_gloves" | "gift_brush" | "gift_socks";

export type RewardType = "discount" | "gift";

export type DiscountCollectionKey = "clubs" | "accessories" | "apparel";

export interface DiscountReward {
  readonly percentage: number;
  /** Which regular priced collection the code applies to. GID comes from env. */
  readonly collection: DiscountCollectionKey;
}

export interface GiftReward {
  /** Human readable gift name shown to the customer. */
  readonly name: string;
}

export type WheelIcon = "club" | "glove" | "brush" | "sock" | "shirt" | "bag";

export interface Slice {
  /** 1-based slice number as shown on the wheel. */
  readonly index: number;
  /** Full reward name: result cards, discount titles, the metafield. */
  readonly label: string;
  /** Short label printed on the wheel face (uppercase, two lines at most). */
  readonly wheelLabel: string;
  readonly icon: WheelIcon;
  readonly rewardKey: RewardKey;
  readonly rewardType: RewardType;
  /** Integer percentage. All slices must sum to exactly 100. */
  readonly probability: number;
  readonly discount?: DiscountReward;
  readonly gift?: GiftReward;
}

/**
 * The approved reward table. Order matters: the outcome mapping walks this
 * array in order and lands on the first slice whose cumulative probability
 * exceeds the roll. Every slice awards something; there is no decorative
 * "try again" slice.
 */
export const SLICES: readonly Slice[] = [
  {
    index: 1,
    label: "10% Off Eligible Clubs",
    wheelLabel: "10% Off Clubs",
    icon: "club",
    rewardKey: "clubs_10",
    rewardType: "discount",
    probability: 25,
    discount: { percentage: 10, collection: "clubs" },
  },
  {
    index: 2,
    label: "GFJ Gloves",
    wheelLabel: "GFJ Gloves",
    icon: "glove",
    rewardKey: "gift_gloves",
    rewardType: "gift",
    probability: 4,
    gift: { name: "GFJ Gloves" },
  },
  {
    index: 3,
    label: "15% Off Eligible Accessories",
    wheelLabel: "15% Off Accessories",
    icon: "bag",
    rewardKey: "accessories_15",
    rewardType: "discount",
    probability: 25,
    discount: { percentage: 15, collection: "accessories" },
  },
  {
    index: 4,
    label: "GFJ Club Brush",
    wheelLabel: "GFJ Club Brush",
    icon: "brush",
    rewardKey: "gift_brush",
    rewardType: "gift",
    probability: 4,
    gift: { name: "GFJ Club Brush" },
  },
  {
    index: 5,
    label: "GFJ Socks",
    wheelLabel: "GFJ Socks",
    icon: "sock",
    rewardKey: "gift_socks",
    rewardType: "gift",
    probability: 4,
    gift: { name: "GFJ Socks" },
  },
  {
    index: 6,
    label: "30% Off Eligible Apparel",
    wheelLabel: "30% Off Apparel",
    icon: "shirt",
    rewardKey: "apparel_30",
    rewardType: "discount",
    probability: 25,
    discount: { percentage: 30, collection: "apparel" },
  },
  {
    index: 7,
    label: "GFJ Gloves",
    wheelLabel: "GFJ Gloves",
    icon: "glove",
    rewardKey: "gift_gloves",
    rewardType: "gift",
    probability: 4,
    gift: { name: "GFJ Gloves" },
  },
  {
    index: 8,
    label: "GFJ Club Brush",
    wheelLabel: "GFJ Club Brush",
    icon: "brush",
    rewardKey: "gift_brush",
    rewardType: "gift",
    probability: 4,
    gift: { name: "GFJ Club Brush" },
  },
  {
    index: 9,
    label: "GFJ Socks",
    wheelLabel: "GFJ Socks",
    icon: "sock",
    rewardKey: "gift_socks",
    rewardType: "gift",
    probability: 5,
    gift: { name: "GFJ Socks" },
  },
];

/**
 * Validates a reward table. Pure so the tests can feed it broken tables.
 * Returns the list of problems; an empty list means the table is valid.
 */
export function validateRewardTable(slices: readonly Slice[]): string[] {
  const problems: string[] = [];
  const sum = slices.reduce((acc, s) => acc + s.probability, 0);
  if (sum !== 100) problems.push(`probabilities sum to ${sum}, expected exactly 100`);
  if (slices.length === 0) problems.push("reward table is empty");
  slices.forEach((s, i) => {
    if (s.index !== i + 1) problems.push(`slice at position ${i} has index ${s.index}`);
    if (!Number.isInteger(s.probability) || s.probability <= 0) {
      problems.push(`slice ${s.index} must have a positive integer probability`);
    }
    if (s.rewardType === "discount" && !s.discount) {
      problems.push(`slice ${s.index} is a discount but has no discount config`);
    }
    if (s.rewardType === "gift" && !s.gift) {
      problems.push(`slice ${s.index} is a gift but has no gift config`);
    }
    if (!s.wheelLabel || !s.icon) problems.push(`slice ${s.index} needs a wheel label and an icon`);
  });
  return problems;
}

export function assertRewardTable(slices: readonly Slice[] = SLICES): void {
  const problems = validateRewardTable(slices);
  if (problems.length > 0) {
    throw new Error(`Invalid reward table:\n - ${problems.join("\n - ")}`);
  }
}

// Startup assertion. Importing this module anywhere fails fast on a bad table.
assertRewardTable(SLICES);

/** Discount code and gift reference formats. The gift reference is an internal idempotency handle. */
export const CODE_FORMAT = {
  /** 32 characters, so `byte % 32` is a uniform pick with no modulo bias. */
  alphabet: "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
  /** Live codes are the bare eight-character suffix: customers type them on a phone. */
  discountPrefix: "",
  /** Test codes keep a marker so they can be found and bulk deleted. */
  testDiscountPrefix: "TEST-",
  discountLength: 8,
  giftPrefix: "GFJ-",
  giftLength: 6,
} as const;

/** The campaign's name as it appears in Shopify admin. Reused wherever the promotion is named. */
export const CAMPAIGN_TITLE = "2026 Oct Spin Wheel of Fortune Promotion";

/**
 * Discount titles. Live: "<campaign> - 10% Clubs". Test: "<campaign> TEST - 10% Clubs", with
 * the marker right after the campaign name so an admin search separates them. The cleanup
 * script matches on `testPrefix`.
 */
export const DISCOUNT_TITLE = {
  prefix: CAMPAIGN_TITLE,
  testPrefix: `${CAMPAIGN_TITLE} TEST`,
} as const;

/** Short reward text for titles, e.g. "10% Clubs". */
export function discountRewardShort(slice: Slice): string {
  if (!slice.discount) throw new Error(`slice ${slice.index} is not a discount`);
  const c = slice.discount.collection;
  return `${slice.discount.percentage}% ${c.charAt(0).toUpperCase()}${c.slice(1)}`;
}

/** Builds the admin title for a discount created by a spin. Deterministic per slice. */
export function discountTitle(slice: Slice, testMode: boolean): string {
  return `${testMode ? DISCOUNT_TITLE.testPrefix : DISCOUNT_TITLE.prefix} - ${discountRewardShort(slice)}`;
}

/** Store-owned order metafield holding the spin result. */
export const SPIN_METAFIELD = {
  namespace: "greentee_spin",
  key: "result",
  type: "json",
  ownerType: "ORDER",
  name: "Spin to Win result",
} as const;

export const SPIN_RESULT_VERSION = 1;

/** How long a signed spin URL stays valid. Spins only start from the Thank you page. */
export const SPIN_TOKEN_TTL_SECONDS = 24 * 60 * 60;

/** Default storefront path of the page that hosts the wheel block. */
export const DEFAULT_SPIN_PAGE_PATH = "/pages/spin-to-win";

/* ------------------------------------------------------------------ gifts */

/** Order tags that let staff find customers who dropped off before the gift was added. */
export const GIFT_TAGS = {
  pending: "gift-pending",
  added: "gift-added",
} as const;

export type GiftKey = Extract<RewardKey, "gift_gloves" | "gift_socks" | "gift_brush">;

export interface GiftProduct {
  readonly rewardKey: GiftKey;
  readonly productId: string;
  /** Customer facing product name. */
  readonly title: string;
  /** Options fixed on every variant; never shown as a choice. Matched case-insensitively. */
  readonly fixedOptions: Readonly<Record<string, string>>;
  /**
   * Options the customer chooses, in display order. Empty when there is
   * nothing to choose. All of them are picked in one step; availability is
   * per combination, not per value.
   */
  readonly customerOptions: readonly string[];
  /** An option the app resolves by stock (the colour), or null when the product has none to pick. */
  readonly pickedOption: string | null;
  /** Copy shown with the gift. Must state anything the customer does not get to choose. */
  readonly note: string;
}

/**
 * Gift products. All product and variant identity lives here and nowhere
 * else, because the socks product is provisional and may change.
 */
export const GIFT_CATALOG: Readonly<Record<GiftKey, GiftProduct>> = {
  gift_gloves: {
    rewardKey: "gift_gloves",
    productId: "gid://shopify/Product/8799392006334",
    title: "GFJ Aura Control Glove (Unisex)",
    // 18 variants: Hand (LH, RH) x Size (18 to 26). Colour is White only, so
    // there is nothing to auto-select: no colour logic for gloves.
    fixedOptions: {},
    customerOptions: ["Hand", "Size"],
    pickedOption: null,
    note: "Choose your hand and size.",
  },
  gift_socks: {
    rewardKey: "gift_socks",
    // PROVISIONAL: the socks product may change before launch.
    productId: "gid://shopify/Product/7884953583806",
    title: "GFJ Jacquard Ankle High Socks",
    fixedOptions: {},
    customerOptions: [],
    pickedOption: "Colour",
    note: "Colour is randomly selected.",
  },
  gift_brush: {
    rewardKey: "gift_brush",
    productId: "gid://shopify/Product/8495558852798",
    title: "GFJ x GreenTee Golf Club Cleaning Brush",
    fixedOptions: {},
    customerOptions: [],
    pickedOption: "Colour",
    note: "Colour is randomly selected.",
  },
};

/** The 100% line discount applied to the gift line so the customer pays nothing. */
export const GIFT_LINE_DISCOUNT = {
  percentValue: 100,
  description: "Spin to Win gift",
} as const;

export function giftProductFor(rewardKey: RewardKey): GiftProduct | null {
  return rewardKey in GIFT_CATALOG ? GIFT_CATALOG[rewardKey as GiftKey] : null;
}

/* ------------------------------------------------------- disclosure */

/** Customer facing names for the two reward kinds, shown as chips. */
/**
 * Short reward name for headings ("15% off accessories", "GFJ Gloves"), as
 * opposed to `label`, the full name used on discount titles and the record.
 */
export function rewardShortLabel(rewardKey: string): string {
  const slice = SLICES.find((s) => s.rewardKey === rewardKey);
  if (!slice) return rewardKey;
  if (slice.discount) return `${slice.discount.percentage}% off ${slice.discount.collection}`;
  return slice.wheelLabel;
}

/** Public storefront origin; every "shop" link on a result card starts here. */
export const SHOP_ORIGIN = "https://shop.greenteegolfshop.com";

/**
 * Where a discount winner lands after the code is applied. Shopify's
 * /discount/CODE?redirect=PATH URL attaches the code to the cart, then
 * redirects. One entry per discount reward; the storefront modal keeps a
 * copy (spin-page.js cannot import this module) and a test pins them equal.
 */
export const REWARD_REDIRECTS: Readonly<Record<DiscountCollectionKey, string>> = {
  clubs: "/collections/clubs-regular-priced",
  accessories: "/collections/accessories-regular-priced",
  apparel: "/collections/apparel-regular-priced",
};

/** The "Shop with discount" link for a discount reward. Unknown rewards fall back to the home page. */
export function discountShopUrl(rewardKey: string, code: string): string {
  const slice = SLICES.find((s) => s.rewardKey === rewardKey);
  const path = slice?.discount ? REWARD_REDIRECTS[slice.discount.collection] : "/";
  return `${SHOP_ORIGIN}/discount/${encodeURIComponent(code)}?redirect=${encodeURIComponent(path)}`;
}

export const REWARD_TYPE_LABELS: Readonly<Record<RewardType, string>> = {
  discount: "Discount",
  gift: "Free gift",
};

export interface RewardOdds {
  /** Whole percent chance of a discount code. */
  readonly discountPercent: number;
  /** Whole percent chance of a gift. */
  readonly giftPercent: number;
}

/**
 * The odds shown under the wheel, derived from the reward table so they can
 * never drift from what the app actually rolls.
 */
export function rewardOdds(slices: readonly Slice[] = SLICES): RewardOdds {
  const sum = (type: RewardType) =>
    slices.filter((s) => s.rewardType === type).reduce((acc, s) => acc + s.probability, 0);
  return { discountPercent: sum("discount"), giftPercent: sum("gift") };
}
