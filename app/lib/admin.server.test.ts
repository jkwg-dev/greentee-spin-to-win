import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createAdminClient } from "./admin.server";
import { log, setLogSink, type LogLine } from "./log.server";

let lines: LogLine[] = [];
beforeEach(() => {
  lines = [];
  setLogSink((l) => lines.push(l));
});
afterEach(() => setLogSink(null));

type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

function client(handlers: Handler[]) {
  let i = 0;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    const h = handlers[Math.min(i, handlers.length - 1)];
    i++;
    return h(url, init);
  }) as unknown as typeof fetch;
  return createAdminClient({
    shopDomain: "greentee.myshopify.com",
    apiKey: "key",
    apiSecret: "secret",
    fetchImpl,
    sleep: async () => {},
    maxThrottleRetries: 2,
  });
}

const token = () =>
  new Response(JSON.stringify({ access_token: "tok", expires_in: 86399, scope: "write_orders" }), {
    status: 200,
  });
const gql = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe("admin client logging", () => {
  it("logs the operation, the order ID, the cost and any userErrors on every call", async () => {
    const admin = client([
      () => token(),
      () =>
        gql({
          data: {
            metafieldsSet: {
              metafields: null,
              userErrors: [{ field: ["value"], code: "INVALID", message: "bad json" }],
            },
          },
          extensions: {
            cost: {
              actualQueryCost: 10,
              throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 990, restoreRate: 50 },
            },
          },
        }),
    ]);
    await admin.request("mutation {}", {}, { operation: "metafieldsSet", orderId: "123" });
    const line = lines.find((l) => l.event === "admin.request")!;
    expect(line).toMatchObject({
      operation: "metafieldsSet",
      orderId: "123",
      cost: 10,
      available: 990,
    });
    expect(line.userErrors).toEqual([{ field: ["value"], code: "INVALID", message: "bad json" }]);
    expect(lines.find((l) => l.event === "admin.token.refreshed")).toMatchObject({
      scope: "write_orders",
    });
  });

  it("retries a throttled request after a delay derived from the throttle status", async () => {
    const admin = client([
      () => token(),
      () =>
        gql({
          errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
          extensions: {
            cost: {
              requestedQueryCost: 100,
              throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 20, restoreRate: 50 },
            },
          },
        }),
      () => gql({ data: { order: { id: "gid://shopify/Order/1" } } }),
    ]);
    const data = await admin.request<{ order: { id: string } }>(
      "query {}",
      {},
      { operation: "order", orderId: "1" },
    );
    expect(data.order.id).toBe("gid://shopify/Order/1");
    expect(lines.find((l) => l.event === "admin.throttled.retry")).toMatchObject({
      operation: "order",
      orderId: "1",
      delayMs: 1600,
    });
  });

  it("refreshes the token once on a 401 and reuses it afterwards", async () => {
    let tokens = 0;
    const admin = client([
      () => {
        tokens++;
        return token();
      },
      () => gql({}, 401),
      () => {
        tokens++;
        return token();
      },
      () => gql({ data: { ok: true } }),
      () => gql({ data: { ok: true } }),
    ]);
    await admin.request("query {}", {}, { operation: "a" });
    await admin.request("query {}", {}, { operation: "b" });
    expect(tokens).toBe(2);
    expect(lines.filter((l) => l.event === "admin.unauthorized.refreshing_token")).toHaveLength(1);
  });

  it("does not make the caller log the same failure twice", async () => {
    // A scope failure like "Access denied for customer field" arrives as a
    // top-level GraphQL error. admin.request logs it with the operation and
    // order ID, so the route's catch must not repeat the payload and a stack.
    const admin = client([
      () => token(),
      () =>
        gql({
          errors: [
            {
              message:
                "Access denied for customer field. Required access: read_customers access scope.",
            },
          ],
        }),
    ]);
    const err = await admin
      .request("query {}", {}, { operation: "order", orderId: "5678" })
      .catch((e) => e);
    lines.length = 0;
    log.error("status.failed", { orderId: "5678", error: err });
    const logged = lines[0].error as Record<string, unknown>;
    expect(logged).toEqual({
      name: "AdminGraphqlError",
      message: "Admin API errors for order",
      alreadyLogged: true,
    });
    expect(logged.stack).toBeUndefined();
    expect(logged.details).toBeUndefined();
  });

  it("surfaces top-level GraphQL errors as non-retryable with details", async () => {
    const admin = client([
      () => token(),
      () => gql({ errors: [{ message: "Field 'nope' doesn't exist" }] }),
    ]);
    await expect(
      admin.request("query {}", {}, { operation: "x", orderId: "9" }),
    ).rejects.toMatchObject({
      name: "AdminGraphqlError",
      retryable: false,
    });
    expect(lines.find((l) => l.event === "admin.request")).toMatchObject({
      orderId: "9",
      errors: [{ message: "Field 'nope' doesn't exist" }],
    });
  });
});
