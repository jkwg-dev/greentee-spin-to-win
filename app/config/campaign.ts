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
  | "clubs_10"
  | "accessories_15"
  | "apparel_30"
  | "gift_gloves"
  | "gift_brush"
  | "gift_socks"
  | "try_again";

export type RewardType = "discount" | "gift" | "none";

export type DiscountCollectionKey = "clubs" | "accessories" | "apparel";

export interface DiscountReward {
  readonly percentage: number;
  /** Which regular priced collection the code applies to. GID comes from env. */
  readonly collection: DiscountCollectionKey;
}

export interface GiftReward {
  /** Human readable gift name used in claim instructions. */
  readonly name: string;
}

export type WheelIcon = "club" | "glove" | "brush" | "sock" | "shirt" | "bag" | "trophy";

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

export const TRY_AGAIN_SLICE_INDEX = 10;

/**
 * The approved reward table. Order matters: the outcome mapping walks this
 * array in order and lands on the first slice whose cumulative probability
 * exceeds the roll. Slice 10 ("Try Again") is decorative and has 0%.
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
  {
    index: TRY_AGAIN_SLICE_INDEX,
    label: "Try Again",
    wheelLabel: "Try Again",
    icon: "trophy",
    rewardKey: "try_again",
    rewardType: "none",
    probability: 0,
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
  if (slices.length !== 10) problems.push(`expected 10 slices, found ${slices.length}`);
  slices.forEach((s, i) => {
    if (s.index !== i + 1) problems.push(`slice at position ${i} has index ${s.index}`);
    if (!Number.isInteger(s.probability) || s.probability < 0) {
      problems.push(`slice ${s.index} has a non-integer or negative probability`);
    }
    if (s.rewardType === "discount" && !s.discount) {
      problems.push(`slice ${s.index} is a discount but has no discount config`);
    }
    if (s.rewardType === "gift" && !s.gift) {
      problems.push(`slice ${s.index} is a gift but has no gift config`);
    }
    if (s.rewardType === "none" && s.probability !== 0) {
      problems.push(`slice ${s.index} awards nothing but has probability ${s.probability}`);
    }
  });
  const tryAgain = slices.find((s) => s.index === TRY_AGAIN_SLICE_INDEX);
  if (!tryAgain || tryAgain.rewardKey !== "try_again" || tryAgain.probability !== 0) {
    problems.push(`slice ${TRY_AGAIN_SLICE_INDEX} must be try_again with 0% probability`);
  }
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

/** Discount / claim reference formats. */
export const CODE_FORMAT = {
  /** 32 characters, so `byte % 32` is a uniform pick with no modulo bias. */
  alphabet: "ABCDEFGHJKLMNPQRSTUVWXYZ23456789",
  discountPrefix: "GT-",
  testDiscountPrefix: "GT-TEST-",
  discountLength: 8,
  giftPrefix: "GFJ-",
  giftLength: 6,
} as const;

/** Discount titles, used by cleanup to find test discounts. */
export const DISCOUNT_TITLE = {
  prefix: "Spin",
  testPrefix: "Spin TEST",
} as const;

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
