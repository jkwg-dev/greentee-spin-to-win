import { describe, expect, it } from "vitest";
import { fetchStatus, parseStatus } from "./api";

describe("parseStatus", () => {
  it("maps the closed state", () => {
    expect(parseStatus({ campaignOpen: false })).toEqual({ kind: "closed" });
  });

  it("maps pending", () => {
    expect(parseStatus({ campaignOpen: true, pending: true })).toEqual({ kind: "pending" });
  });

  it("maps eligible with and without a spin URL", () => {
    expect(
      parseStatus({
        campaignOpen: true,
        pending: false,
        alreadySpun: false,
        eligible: true,
        testMode: false,
        spinUrl: "https://x/y?token=t",
      }),
    ).toEqual({ kind: "eligible", spinUrl: "https://x/y?token=t", testMode: false });
    expect(
      parseStatus({
        campaignOpen: true,
        pending: false,
        alreadySpun: false,
        eligible: true,
        testMode: true,
      }),
    ).toEqual({
      kind: "eligible",
      spinUrl: null,
      testMode: true,
    });
  });

  it("maps ineligible with its message", () => {
    expect(
      parseStatus({
        campaignOpen: true,
        pending: false,
        alreadySpun: false,
        eligible: false,
        testMode: false,
        reason: "below_minimum",
        message: "Next time!",
      }),
    ).toEqual({ kind: "ineligible", message: "Next time!", testMode: false });
  });

  it("maps a stored result", () => {
    const result = {
      sliceIndex: 3,
      rewardKey: "accessories_15",
      rewardLabel: "15% Off Eligible Accessories",
      rewardType: "discount",
      code: "ABCDEFGH",
      gift: null,
      spunAt: "2026-10-03T18:22:41.000Z",
      expiresAt: "2026-11-02T17:00:00.000Z",
      expired: false,
      testMode: false,
    };
    expect(
      parseStatus({
        campaignOpen: true,
        pending: false,
        alreadySpun: true,
        eligible: true,
        testMode: false,
        result,
      }),
    ).toEqual({ kind: "spun", testMode: false, spinUrl: null, result });
  });

  it("treats junk as a retryable error", () => {
    expect(parseStatus(null)).toMatchObject({ kind: "error", retryable: true });
    expect(parseStatus({ campaignOpen: "yes" })).toMatchObject({ kind: "error", retryable: true });
    expect(parseStatus({ campaignOpen: true, pending: false })).toMatchObject({
      kind: "error",
      retryable: true,
    });
  });
});

describe("fetchStatus", () => {
  const base = {
    appUrl: "https://spin.example.com/",
    orderId: "123",
    getSessionToken: async () => "jwt",
  };

  it("posts the order id with the bearer token and parses the reply", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(JSON.stringify({ campaignOpen: true, pending: true }), { status: 200 });
    }) as unknown as typeof fetch;
    expect(await fetchStatus({ ...base, fetchImpl })).toEqual({ kind: "pending" });
    expect(seen!.url).toBe("https://spin.example.com/api/spin/status");
    expect(seen!.init.method).toBe("POST");
    expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer jwt");
    expect(JSON.parse(String(seen!.init.body))).toEqual({ orderId: "123" });
  });

  it("marks auth failures as not retryable and server errors as retryable", async () => {
    const status = (code: number) =>
      (async () => new Response("{}", { status: code })) as unknown as typeof fetch;
    expect(await fetchStatus({ ...base, fetchImpl: status(401) })).toMatchObject({
      kind: "error",
      retryable: false,
    });
    expect(await fetchStatus({ ...base, fetchImpl: status(503) })).toMatchObject({
      kind: "error",
      retryable: true,
    });
  });

  it("treats a network failure or a token failure as retryable", async () => {
    const boom = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    expect(await fetchStatus({ ...base, fetchImpl: boom })).toMatchObject({
      kind: "error",
      retryable: true,
      detail: "network",
    });
    expect(
      await fetchStatus({
        ...base,
        getSessionToken: async () => {
          throw new Error("no");
        },
      }),
    ).toMatchObject({
      kind: "error",
      detail: "session token",
    });
  });
});
