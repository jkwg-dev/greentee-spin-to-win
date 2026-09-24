import { describe, expect, it } from "vitest";
import { normalizeHost } from "./host";

describe("normalizeHost", () => {
  it("accepts a bare host, which is how some Shopify session tokens send dest", () => {
    expect(normalizeHost("greentee.myshopify.com")).toBe("greentee.myshopify.com");
  });

  it("accepts a full URL and ignores scheme, path and trailing slash", () => {
    for (const v of [
      "https://greentee.myshopify.com",
      "https://greentee.myshopify.com/",
      "http://greentee.myshopify.com/admin",
      "greentee.myshopify.com/",
    ]) {
      expect(normalizeHost(v)).toBe("greentee.myshopify.com");
    }
  });

  it("normalises case, whitespace and a port", () => {
    expect(normalizeHost("  GreenTee.MyShopify.COM  ")).toBe("greentee.myshopify.com");
    expect(normalizeHost("https://Shop.GreenTeeGolfShop.com:443/x")).toBe(
      "shop.greenteegolfshop.com",
    );
  });

  it("returns null rather than throwing on unusable input", () => {
    for (const v of [undefined, null, 42, "", "   ", "https://"]) {
      expect(normalizeHost(v)).toBeNull();
    }
  });
});
