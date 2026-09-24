import { describe, expect, it } from "vitest";
import {
  CODE_FORMAT,
  REWARD_TYPE_LABELS,
  SLICES,
  assertRewardTable,
  rewardOdds,
  validateRewardTable,
  type Slice,
} from "~/config/campaign";
import { parseSpinResult } from "./spin-result";
import {
  ForceSliceError,
  OrderIdError,
  deriveDiscountCode,
  deriveGiftReference,
  deriveOutcome,
  normalizeOrderId,
  outcomeDigest,
  resolveForcedSlice,
  rollFromDigest,
  rollFromHex,
  selectSlice,
} from "./outcome";

const SECRET = "unit-test-secret";
const EPS = 1 / 0x1_0000_0000; // one 32-bit step, the smallest roll granularity

/** Cumulative upper bounds per slice, as fractions. */
function cumulative(): number[] {
  const out: number[] = [];
  let acc = 0;
  for (const s of SLICES) {
    acc += s.probability;
    out.push(acc / 100);
  }
  return out;
}

describe("reward table", () => {
  it("sums to exactly 100 and passes the startup assertion", () => {
    expect(SLICES.reduce((a, s) => a + s.probability, 0)).toBe(100);
    expect(() => assertRewardTable()).not.toThrow();
  });

  it("gives every slice a short wheel label and an icon", () => {
    for (const s of SLICES) {
      expect(s.wheelLabel.length).toBeGreaterThan(0);
      expect(s.wheelLabel.length).toBeLessThanOrEqual(20);
      expect(s.icon).toBeTruthy();
    }
  });

  it("has nine slices that all award something", () => {
    expect(SLICES).toHaveLength(9);
    expect(SLICES.every((s) => s.probability > 0 && s.rewardType !== undefined)).toBe(true);
  });

  it("splits 75% discounts / 25% gifts", () => {
    const by = (type: Slice["rewardType"]) =>
      SLICES.filter((s) => s.rewardType === type).reduce((a, s) => a + s.probability, 0);
    expect(by("discount")).toBe(75);
    expect(by("gift")).toBe(25);
  });

  it("derives the displayed odds from the table: 75% discount, 25% gift", () => {
    const odds = rewardOdds();
    expect(odds).toEqual({ discountPercent: 75, giftPercent: 25 });
    expect(odds.discountPercent + odds.giftPercent).toBe(100);
    // Sanity: the derivation really follows the table, not a constant.
    const skewed = SLICES.map((s) =>
      s.index === 1 ? { ...s, probability: 5 } : s.index === 2 ? { ...s, probability: 24 } : s,
    );
    expect(rewardOdds(skewed)).toEqual({ discountPercent: 55, giftPercent: 45 });
  });

  it("names both reward kinds for the chips", () => {
    expect(REWARD_TYPE_LABELS).toEqual({ discount: "Discount", gift: "Free gift" });
  });

  it("rejects a table that does not sum to 100", () => {
    const broken = SLICES.map((s) => (s.index === 1 ? { ...s, probability: 26 } : s));
    expect(validateRewardTable(broken)).toContain("probabilities sum to 101, expected exactly 100");
    expect(() => assertRewardTable(broken)).toThrow(/Invalid reward table/);
  });

  it("rejects a zero-probability slice", () => {
    const broken = [
      ...SLICES.map((s) => (s.index === 1 ? { ...s, probability: 25 } : s)),
      { ...SLICES[0], index: 10, probability: 0 },
    ];
    expect(validateRewardTable(broken).join("\n")).toMatch(
      /slice 10 must have a positive integer probability/,
    );
  });
});

describe("selectSlice boundaries", () => {
  const bounds = cumulative();

  it("maps 0 to slice 1", () => {
    expect(selectSlice(0).index).toBe(1);
  });

  it.each(SLICES.filter((s) => s.probability > 0).map((s) => [s.index]))(
    "slice %i owns [lower, upper) exactly",
    (index) => {
      const i = index - 1;
      const lower = i === 0 ? 0 : bounds[i - 1];
      const upper = bounds[i];
      // Just inside the lower edge and just inside the upper edge belong to this slice.
      expect(selectSlice(lower).index).toBe(index);
      expect(selectSlice(upper - EPS).index).toBe(index);
      // The upper edge itself belongs to the next slice, except for the last slice whose edge is 1.
      if (upper < 1) expect(selectSlice(upper).index).toBe(index + 1);
    },
  );

  it("maps the largest possible roll to the last slice, never outside the table", () => {
    expect(rollFromHex("ffffffff")).toBeLessThan(1);
    expect(selectSlice(rollFromHex("ffffffff")).index).toBe(9);
    expect(selectSlice(1 - EPS).index).toBe(9);
  });

  it("refuses rolls outside [0, 1)", () => {
    expect(() => selectSlice(1)).toThrow(/out of range/);
    expect(() => selectSlice(-EPS)).toThrow(/out of range/);
    expect(() => selectSlice(Number.NaN)).toThrow(/out of range/);
  });

  it("would throw rather than pick nothing if the table were short", () => {
    const short = SLICES.map((s) => (s.index === 9 ? { ...s, probability: 0 } : s));
    expect(() => selectSlice(0.999, short)).toThrow(/inconsistent/);
  });
});

describe("digest and roll", () => {
  it("is deterministic and depends on the secret", () => {
    const a = outcomeDigest(SECRET, 12345);
    const b = outcomeDigest(SECRET, "12345");
    const c = outcomeDigest("other-secret", 12345);
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
  });

  it("reduces all three identifier shapes to the same numeric ID", () => {
    // The thank you target sends OrderIdentity, the order status target sends
    // Order, scripts send a bare number. All are the same order.
    for (const id of [
      "gid://shopify/Order/987",
      "gid://shopify/OrderIdentity/987",
      "987",
      987,
      "  gid://shopify/OrderIdentity/987  ",
    ]) {
      expect(normalizeOrderId(id)).toBe("987");
    }
  });

  it("rejects an unrecognised identifier and reports what it received", () => {
    expect(() => normalizeOrderId("gid://shopify/Product/1")).toThrow(OrderIdError);
    try {
      normalizeOrderId("gid://shopify/Product/1");
    } catch (e) {
      expect((e as OrderIdError).received).toBe("gid://shopify/Product/1");
      expect((e as Error).message).toMatch(/Expected a numeric order ID/);
    }
    expect(() => normalizeOrderId("")).toThrow(OrderIdError);
    // A hostile value is truncated before it reaches a response or a log.
    const long = "x".repeat(500);
    try {
      normalizeOrderId(long);
    } catch (e) {
      expect((e as OrderIdError).received.length).toBeLessThanOrEqual(123);
    }
  });

  it("uses the first 8 hex characters divided by 2^32", () => {
    const digest = outcomeDigest(SECRET, 42);
    const hex = digest.toString("hex");
    expect(rollFromDigest(digest)).toBe(parseInt(hex.slice(0, 8), 16) / 0x1_0000_0000);
    expect(rollFromHex("00000000")).toBe(0);
    expect(rollFromHex("80000000")).toBe(0.5);
  });

  it("requires a secret", () => {
    expect(() => outcomeDigest("", 1)).toThrow(/SPIN_SECRET/);
  });
});

describe("deriveOutcome over many orders", () => {
  const N = 200_000;
  const counts = new Map<number, number>();
  for (let id = 1; id <= N; id++) {
    const { slice } = deriveOutcome(SECRET, id);
    counts.set(slice.index, (counts.get(slice.index) ?? 0) + 1);
  }

  it("only ever lands inside the table", () => {
    expect([...counts.keys()].every((i) => i >= 1 && i <= SLICES.length)).toBe(true);
  });

  it("tracks the probability table within one percentage point", () => {
    for (const s of SLICES) {
      const observed = ((counts.get(s.index) ?? 0) / N) * 100;
      expect(Math.abs(observed - s.probability)).toBeLessThan(1);
    }
  });
});

describe("codes", () => {
  const digest = outcomeDigest(SECRET, 555);
  const alphabetRe = new RegExp(`^[${CODE_FORMAT.alphabet}]+$`);

  it("formats live discount codes as GT- plus 8 unambiguous characters", () => {
    const code = deriveDiscountCode(digest);
    expect(code.startsWith("GT-")).toBe(true);
    expect(code.startsWith("GT-TEST-")).toBe(false);
    const suffix = code.slice(3);
    expect(suffix).toHaveLength(8);
    expect(suffix).toMatch(alphabetRe);
    expect(suffix).not.toMatch(/[O0I1]/);
  });

  it("formats test discount codes as GT-TEST- with the same suffix", () => {
    const live = deriveDiscountCode(digest);
    const test = deriveDiscountCode(digest, { testMode: true });
    expect(test).toBe("GT-TEST-" + live.slice(3));
  });

  it("formats gift references as GFJ- plus 6 characters", () => {
    const ref = deriveGiftReference(digest);
    expect(ref).toMatch(new RegExp(`^GFJ-[${CODE_FORMAT.alphabet}]{6}$`));
  });

  it("is stable across calls and differs between orders", () => {
    expect(deriveOutcome(SECRET, 1).discountCode).toBe(deriveOutcome(SECRET, 1).discountCode);
    expect(deriveOutcome(SECRET, 1).discountCode).not.toBe(deriveOutcome(SECRET, 2).discountCode);
  });
});

describe("stale records from an older reward table", () => {
  it("parses a stored result whose slice index no longer exists", () => {
    // The stored reward label, key and code are authoritative; the index is
    // only used to point the wheel, which clamps. Nothing throws.
    const raw = JSON.stringify({
      version: 1,
      spunAt: "2026-09-20T00:00:00.000Z",
      sliceIndex: 10,
      rewardKey: "clubs_10",
      rewardLabel: "10% Off Eligible Clubs",
      rewardType: "discount",
      code: "GT-ABCDEFGH",
      expiresAt: "2026-11-02T17:00:00.000Z",
    });
    expect(parseSpinResult(raw)).toMatchObject({ sliceIndex: 10, rewardKey: "clubs_10" });
  });
});

describe("resolveForcedSlice", () => {
  it("accepts 1 through 9 as numbers or numeric strings", () => {
    for (let i = 1; i <= 9; i++) {
      expect(resolveForcedSlice(i).index).toBe(i);
      expect(resolveForcedSlice(String(i)).index).toBe(i);
    }
  });

  it("rejects slice 10, which no longer exists", () => {
    expect(() => resolveForcedSlice(10)).toThrow(ForceSliceError);
  });

  it("rejects out of range and non-integer input", () => {
    for (const bad of [0, 11, -1, 1.5, "abc", "", null, undefined, {}]) {
      expect(() => resolveForcedSlice(bad)).toThrow(ForceSliceError);
    }
  });
});

describe("identifier shape cannot change the outcome", () => {
  // The HMAC is computed over the normalised numeric ID, so the thank you page
  // and the order status page must derive the same reward for the same order.
  const SHAPES = (id: number) => [
    String(id),
    `gid://shopify/Order/${id}`,
    `gid://shopify/OrderIdentity/${id}`,
  ];

  it("derives an identical slice, code and gift reference from every shape", () => {
    for (let id = 1; id <= 400; id++) {
      const [first, ...rest] = SHAPES(id).map((v) => deriveOutcome(SECRET, v));
      for (const other of rest) {
        expect(other.slice.index).toBe(first.slice.index);
        expect(other.discountCode).toBe(first.discountCode);
        expect(other.giftReference).toBe(first.giftReference);
        expect(other.roll).toBe(first.roll);
      }
    }
  });

  it("derives identical test-mode codes from every shape", () => {
    const codes = SHAPES(8363789484222).map(
      (v) => deriveOutcome(SECRET, v, { testMode: true }).discountCode,
    );
    expect(new Set(codes).size).toBe(1);
    expect(codes[0].startsWith("GT-TEST-")).toBe(true);
  });

  it("produces the same digest for every shape", () => {
    const digests = SHAPES(555).map((v) => outcomeDigest(SECRET, v).toString("hex"));
    expect(new Set(digests).size).toBe(1);
  });
});
