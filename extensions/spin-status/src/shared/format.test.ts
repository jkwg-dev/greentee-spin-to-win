import { describe, expect, it } from "vitest";
import { formatExpiry, formatExpiryShort } from "./format";

describe("formatExpiry", () => {
  it("shows Pacific Time at UTC-7 before November 1", () => {
    expect(formatExpiry("2026-10-31T12:42:13.561Z")).toBe("October 31, 2026 at 5:42 AM PT");
  });

  it("stays at UTC-7 after November 1, whatever the device's time zone data says", () => {
    expect(formatExpiry("2026-11-02T16:00:00.000Z")).toBe("November 2, 2026 at 9:00 AM PT");
    expect(formatExpiry("2026-12-02T07:30:00.000Z")).toBe("December 2, 2026 at 12:30 AM PT");
  });

  it("returns the input when it is not a date", () => {
    expect(formatExpiry("soon")).toBe("soon");
  });
});

describe("formatExpiryShort", () => {
  it("uses the Pacific Time calendar day", () => {
    expect(formatExpiryShort("2026-11-02T16:00:00.000Z")).toBe("Nov 2, 2026");
    // The day turns over at 07:00Z (UTC-7), not 08:00Z.
    expect(formatExpiryShort("2026-11-05T07:30:00.000Z")).toBe("Nov 5, 2026");
    expect(formatExpiryShort("2026-11-05T06:59:00.000Z")).toBe("Nov 4, 2026");
  });
});
