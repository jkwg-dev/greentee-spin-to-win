import { describe, expect, it } from "vitest";
import {
  CODE_FORMAT,
  SLICES,
  TRY_AGAIN_SLICE_INDEX,
  assertRewardTable,
  validateRewardTable,
  type Slice,
} from "~/config/campaign";
import {
  ForceSliceError,
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

  it("has slice 10 as try_again with 0%", () => {
    const s = SLICES[TRY_AGAIN_SLICE_INDEX - 1];
    expect(s.rewardKey).toBe("try_again");
    expect(s.probability).toBe(0);
  });

  it("splits 75% discounts / 25% gifts / 0% nothing", () => {
    const by = (type: Slice["rewardType"]) =>
      SLICES.filter((s) => s.rewardType === type).reduce((a, s) => a + s.probability, 0);
    expect(by("discount")).toBe(75);
    expect(by("gift")).toBe(25);
    expect(by("none")).toBe(0);
  });

  it("rejects a table that does not sum to 100", () => {
    const broken = SLICES.map((s) => (s.index === 1 ? { ...s, probability: 26 } : s));
    expect(validateRewardTable(broken)).toContain("probabilities sum to 101, expected exactly 100");
    expect(() => assertRewardTable(broken)).toThrow(/Invalid reward table/);
  });

  it("rejects a table where try_again is reachable", () => {
    const broken = SLICES.map((s) =>
      s.index === 1
        ? { ...s, probability: 24 }
        : s.index === TRY_AGAIN_SLICE_INDEX
          ? { ...s, probability: 1 }
          : s,
    );
    expect(validateRewardTable(broken).join("\n")).toMatch(/slice 10/);
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
      // The upper edge itself belongs to the next slice (there always is one, slice 10 aside).
      if (upper < 1) expect(selectSlice(upper).index).toBe(index + 1);
    },
  );

  it("maps the largest possible roll to slice 9, never slice 10", () => {
    expect(rollFromHex("ffffffff")).toBeLessThan(1);
    expect(selectSlice(rollFromHex("ffffffff")).index).toBe(9);
    expect(selectSlice(1 - EPS).index).toBe(9);
  });

  it("refuses rolls outside [0, 1)", () => {
    expect(() => selectSlice(1)).toThrow(/out of range/);
    expect(() => selectSlice(-EPS)).toThrow(/out of range/);
    expect(() => selectSlice(Number.NaN)).toThrow(/out of range/);
  });

  it("would throw rather than return slice 10 if the table were short", () => {
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

  it("treats a GID and a numeric ID as the same order", () => {
    expect(normalizeOrderId("gid://shopify/Order/987")).toBe("987");
    expect(normalizeOrderId(987)).toBe("987");
    expect(
      outcomeDigest(SECRET, "gid://shopify/Order/987").equals(outcomeDigest(SECRET, 987)),
    ).toBe(true);
    expect(() => normalizeOrderId("gid://shopify/Product/1")).toThrow(/Unrecognised/);
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

  it("never lands on slice 10", () => {
    expect(counts.get(TRY_AGAIN_SLICE_INDEX) ?? 0).toBe(0);
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

describe("resolveForcedSlice", () => {
  it("accepts 1 through 9 as numbers or numeric strings", () => {
    for (let i = 1; i <= 9; i++) {
      expect(resolveForcedSlice(i).index).toBe(i);
      expect(resolveForcedSlice(String(i)).index).toBe(i);
    }
  });

  it("rejects slice 10 explicitly", () => {
    expect(() => resolveForcedSlice(10)).toThrow(ForceSliceError);
    expect(() => resolveForcedSlice(10)).toThrow(/Try Again/);
  });

  it("rejects out of range and non-integer input", () => {
    for (const bad of [0, 11, -1, 1.5, "abc", "", null, undefined, {}]) {
      expect(() => resolveForcedSlice(bad)).toThrow(ForceSliceError);
    }
  });
});
