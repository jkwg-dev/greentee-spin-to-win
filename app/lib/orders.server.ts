/**
 * Order lookup with retry (the Thank you page can render before the order
 * is queryable) and a short per-order cache for status polling.
 */
import { SPIN_METAFIELD } from "~/config/campaign";
import type { AdminClient } from "~/lib/admin.server";
import type { OrderSnapshot } from "~/lib/eligibility";
import { log } from "~/lib/log.server";
import { normalizeOrderId, orderGid } from "~/lib/outcome";
import { parseSpinResult } from "~/lib/spin-result";

export const ORDER_QUERY = /* GraphQL */ `
  query SpinOrder($id: ID!, $namespace: String!, $key: String!) {
    order(id: $id) {
      id
      name
      email
      createdAt
      tags
      statusPageUrl
      currentSubtotalPriceSet {
        shopMoney {
          amount
          currencyCode
        }
      }
      customer {
        id
        tags
      }
      metafield(namespace: $namespace, key: $key) {
        id
        value
      }
    }
  }
`;

interface OrderQueryData {
  order: {
    id: string;
    name: string;
    email: string | null;
    createdAt: string;
    tags: string[];
    statusPageUrl: string | null;
    currentSubtotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
    customer: {
      id: string;
      tags: string[];
    } | null;
    metafield: { id: string; value: string } | null;
  } | null;
}

export function toSnapshot(o: NonNullable<OrderQueryData["order"]>): OrderSnapshot {
  return {
    id: normalizeOrderId(o.id),
    gid: o.id,
    name: o.name,
    email: o.email,
    createdAt: o.createdAt,
    statusPageUrl: o.statusPageUrl ?? null,
    subtotal: {
      amount: Number(o.currentSubtotalPriceSet.shopMoney.amount),
      currencyCode: o.currentSubtotalPriceSet.shopMoney.currencyCode,
    },
    tags: o.tags,
    customer: o.customer
      ? {
          id: o.customer.id,
          tags: o.customer.tags,
        }
      : null,
    spinResult: parseSpinResult(o.metafield?.value),
  };
}

export interface FetchOrderOptions {
  /** Total attempts including the first. Default 4 (~4.5s with default delays). */
  readonly attempts?: number;
  readonly baseDelayMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Fetches the order, retrying with backoff while Shopify returns null (the
 * order is not queryable yet). Returns null when it still is not.
 */
export async function fetchOrder(
  admin: AdminClient,
  orderId: string | number,
  opts: FetchOrderOptions = {},
): Promise<OrderSnapshot | null> {
  const attempts = opts.attempts ?? 4;
  const base = opts.baseDelayMs ?? 300;
  const sleep = opts.sleep ?? defaultSleep;
  const id = normalizeOrderId(orderId);
  for (let i = 0; i < attempts; i++) {
    const data = await admin.request<OrderQueryData>(
      ORDER_QUERY,
      { id: orderGid(id), namespace: SPIN_METAFIELD.namespace, key: SPIN_METAFIELD.key },
      { operation: "order", orderId: id },
    );
    if (data.order) return toSnapshot(data.order);
    if (i < attempts - 1) {
      const delay = base * 2 ** i;
      log.info("order.not_ready.retry", { orderId: id, attempt: i + 1, delayMs: delay });
      await sleep(delay);
    }
  }
  log.warn("order.not_ready.gave_up", { orderId: id, attempts });
  return null;
}

const CACHE_TTL_MS = 10_000;
const cache = new Map<string, { at: number; order: OrderSnapshot }>();

/** Cached lookup for status polling. Never used on the execute path. */
export async function fetchOrderCached(
  admin: AdminClient,
  orderId: string | number,
  opts: FetchOrderOptions & { now?: () => number } = {},
): Promise<OrderSnapshot | null> {
  const id = normalizeOrderId(orderId);
  const now = opts.now?.() ?? Date.now();
  const hit = cache.get(id);
  if (hit && now - hit.at < CACHE_TTL_MS) return hit.order;
  const order = await fetchOrder(admin, id, opts);
  if (order) cache.set(id, { at: now, order });
  return order;
}

export function invalidateOrderCache(orderId: string | number): void {
  cache.delete(normalizeOrderId(orderId));
}

export function clearOrderCache(): void {
  cache.clear();
}
