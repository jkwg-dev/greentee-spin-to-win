import { describe, expect, it } from "vitest";
import { offsetMinutes, parseAtOffset } from "./time";

const PT = "-07:00";

describe("parseAtOffset", () => {
  it("treats wall-clock times as Pacific Time (UTC-7)", () => {
    expect(parseAtOffset("2026-10-01T00:00:00", PT).toISOString()).toBe("2026-10-01T07:00:00.000Z");
  });

  it("keeps UTC-7 after November 1: British Columbia no longer falls back", () => {
    // Nov 2 09:00 PT = 16:00Z. Time zone data older than 2026a would say 17:00Z.
    expect(parseAtOffset("2026-11-02T09:00:00", PT).toISOString()).toBe("2026-11-02T16:00:00.000Z");
    expect(parseAtOffset("2027-01-15T12:00", PT).toISOString()).toBe("2027-01-15T19:00:00.000Z");
  });

  it("accepts date-only input as local midnight", () => {
    expect(parseAtOffset("2026-10-01", PT).toISOString()).toBe("2026-10-01T07:00:00.000Z");
  });

  it("respects an explicit offset or Z", () => {
    expect(parseAtOffset("2026-11-02T16:00:00Z", PT).toISOString()).toBe(
      "2026-11-02T16:00:00.000Z",
    );
    expect(parseAtOffset("2026-11-02T09:00:00-07:00", PT).toISOString()).toBe(
      "2026-11-02T16:00:00.000Z",
    );
    expect(parseAtOffset("2026-11-02T09:00:00-08:00", PT).toISOString()).toBe(
      "2026-11-02T17:00:00.000Z",
    );
  });

  it("rejects garbage", () => {
    expect(() => parseAtOffset("soon", PT)).toThrow(/Invalid date/);
  });
});

describe("offsetMinutes", () => {
  it("converts an offset string to minutes", () => {
    expect(offsetMinutes("-07:00")).toBe(-420);
    expect(offsetMinutes("+05:30")).toBe(330);
    expect(() => offsetMinutes("PT")).toThrow(/Invalid UTC offset/);
  });
});
