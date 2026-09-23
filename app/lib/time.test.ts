import { describe, expect, it } from "vitest";
import { parseInZone } from "./time";

const TZ = "America/Vancouver";

describe("parseInZone", () => {
  it("treats wall-clock times as Vancouver local time during PDT", () => {
    // October 1 2026 is PDT (UTC-7).
    expect(parseInZone("2026-10-01T00:00:00", TZ).toISOString()).toBe("2026-10-01T07:00:00.000Z");
  });

  it("treats wall-clock times as Vancouver local time during PST", () => {
    // DST ends Nov 1 2026, so Nov 2 09:00 is PST (UTC-8) = 17:00Z, as in CLAUDE.md.
    expect(parseInZone("2026-11-02T09:00:00", TZ).toISOString()).toBe("2026-11-02T17:00:00.000Z");
  });

  it("accepts date-only input as local midnight", () => {
    expect(parseInZone("2026-10-01", TZ).toISOString()).toBe("2026-10-01T07:00:00.000Z");
  });

  it("respects an explicit offset or Z", () => {
    expect(parseInZone("2026-11-02T17:00:00Z", TZ).toISOString()).toBe("2026-11-02T17:00:00.000Z");
    expect(parseInZone("2026-11-02T09:00:00-08:00", TZ).toISOString()).toBe(
      "2026-11-02T17:00:00.000Z",
    );
  });

  it("rejects garbage", () => {
    expect(() => parseInZone("soon", TZ)).toThrow(/Invalid date/);
  });
});
