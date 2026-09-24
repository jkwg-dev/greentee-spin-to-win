/**
 * Thin Admin GraphQL wrapper.
 *
 * Authentication uses the client credentials grant: the app exchanges its own
 * client ID and secret for a 24 hour access token for the one store it serves.
 * There is no OAuth redirect and no session storage. This requires the store
 * and the app to be in the same Dev Dashboard organisation.
 *
 * Every call logs the operation name, the order ID (when supplied), the query
 * cost, and any `userErrors` found in the response payload. Throttled requests
 * are retried with a delay derived from the throttle status.
 */
import { log, type Logger } from "~/lib/log.server";
import { getEnv } from "~/config/env.server";

export const ADMIN_API_VERSION = "2026-07";

export interface GraphqlContext {
  /** Human readable operation name for logs, e.g. "discountCodeBasicCreate". */
  readonly operation: string;
  readonly orderId?: string;
}

export interface UserError {
  readonly field?: readonly string[] | null;
  readonly message: string;
  readonly code?: string | null;
}

export interface AdminClient {
  request<T = Record<string, unknown>>(
    query: string,
    variables: Record<string, unknown>,
    ctx: GraphqlContext,
  ): Promise<T>;
}

export class AdminGraphqlError extends Error {
  readonly retryable: boolean;
  readonly details: unknown;
  /**
   * True when the request line for this call already carried the details.
   * `serializeError` then logs only the message, so one failure does not
   * print the same GraphQL errors twice plus a stack.
   */
  readonly logged: boolean;
  constructor(
    message: string,
    opts: { retryable: boolean; details?: unknown; cause?: unknown; logged?: boolean },
  ) {
    super(message, { cause: opts.cause });
    this.name = "AdminGraphqlError";
    this.retryable = opts.retryable;
    this.details = opts.details;
    this.logged = opts.logged === true;
  }
}

interface GraphqlResponse<T> {
  data?: T;
  errors?: Array<{
    message: string;
    extensions?: { code?: string; [k: string]: unknown };
  }>;
  extensions?: {
    cost?: {
      requestedQueryCost?: number;
      actualQueryCost?: number;
      throttleStatus?: {
        maximumAvailable: number;
        currentlyAvailable: number;
        restoreRate: number;
      };
    };
  };
}

/** Collects `userErrors` arrays from every top-level mutation payload. */
export function collectUserErrors(data: unknown): UserError[] {
  if (!data || typeof data !== "object") return [];
  const out: UserError[] = [];
  for (const value of Object.values(data as Record<string, unknown>)) {
    if (value && typeof value === "object") {
      const ue = (value as { userErrors?: unknown }).userErrors;
      if (Array.isArray(ue)) out.push(...(ue as UserError[]));
    }
  }
  return out;
}

export interface AdminClientOptions {
  readonly shopDomain: string;
  readonly apiKey: string;
  readonly apiSecret: string;
  readonly apiVersion?: string;
  readonly fetchImpl?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly logger?: Logger;
  readonly maxThrottleRetries?: number;
}

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function createAdminClient(opts: AdminClientOptions): AdminClient {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? defaultSleep;
  const logger = opts.logger ?? log;
  const apiVersion = opts.apiVersion ?? ADMIN_API_VERSION;
  const maxThrottleRetries = opts.maxThrottleRetries ?? 3;
  const tokenUrl = `https://${opts.shopDomain}/admin/oauth/access_token`;
  const graphqlUrl = `https://${opts.shopDomain}/admin/api/${apiVersion}/graphql.json`;

  let token: { value: string; expiresAt: number } | undefined;
  let inflight: Promise<string> | undefined;

  async function fetchToken(): Promise<string> {
    const res = await fetchImpl(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: opts.apiKey,
        client_secret: opts.apiSecret,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new AdminGraphqlError(`Access token request failed: HTTP ${res.status}`, {
        retryable: res.status >= 500,
        details: body.slice(0, 500),
      });
    }
    const json = (await res.json()) as {
      access_token: string;
      expires_in?: number;
      scope?: string;
    };
    // Refresh five minutes early so a token never expires mid-request.
    const ttlMs = ((json.expires_in ?? 86_399) - 300) * 1000;
    token = { value: json.access_token, expiresAt: Date.now() + ttlMs };
    logger.info("admin.token.refreshed", { scope: json.scope, expiresInSeconds: json.expires_in });
    return token.value;
  }

  async function getToken(force = false): Promise<string> {
    if (!force && token && token.expiresAt > Date.now()) return token.value;
    inflight ??= fetchToken().finally(() => (inflight = undefined));
    return inflight;
  }

  async function request<T>(
    query: string,
    variables: Record<string, unknown>,
    ctx: GraphqlContext,
  ): Promise<T> {
    const l = logger.child({
      operation: ctx.operation,
      ...(ctx.orderId ? { orderId: ctx.orderId } : {}),
    });
    let refreshedToken = false;
    for (let attempt = 0; ; attempt++) {
      const started = Date.now();
      const accessToken = await getToken();
      const res = await fetchImpl(graphqlUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": accessToken,
        },
        body: JSON.stringify({ query, variables }),
      });

      if (res.status === 401 && !refreshedToken) {
        refreshedToken = true;
        l.warn("admin.unauthorized.refreshing_token");
        await getToken(true);
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        if (attempt < maxThrottleRetries) {
          const retryAfter = Number(res.headers.get("retry-after")) || 0;
          const delay = Math.max(retryAfter * 1000, 1000 * (attempt + 1));
          l.warn("admin.http.retry", { status: res.status, delayMs: delay });
          await sleep(delay);
          continue;
        }
        throw new AdminGraphqlError(`Admin API HTTP ${res.status}`, { retryable: true });
      }
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new AdminGraphqlError(`Admin API HTTP ${res.status}`, {
          retryable: false,
          details: body.slice(0, 1000),
        });
      }

      const json = (await res.json()) as GraphqlResponse<T>;
      const cost = json.extensions?.cost;
      const throttled = json.errors?.some((e) => e.extensions?.code === "THROTTLED");
      if (throttled) {
        if (attempt < maxThrottleRetries) {
          const ts = cost?.throttleStatus;
          const deficit = (cost?.requestedQueryCost ?? 50) - (ts?.currentlyAvailable ?? 0);
          const delay = Math.max(1000, Math.ceil((deficit / (ts?.restoreRate ?? 50)) * 1000));
          l.warn("admin.throttled.retry", { delayMs: delay, throttleStatus: ts });
          await sleep(delay);
          continue;
        }
        throw new AdminGraphqlError("Admin API throttled", {
          retryable: true,
          details: json.errors,
        });
      }

      const userErrors = collectUserErrors(json.data);
      l.info("admin.request", {
        ms: Date.now() - started,
        cost: cost?.actualQueryCost,
        available: cost?.throttleStatus?.currentlyAvailable,
        ...(json.errors?.length ? { errors: json.errors } : {}),
        ...(userErrors.length ? { userErrors } : {}),
      });

      if (json.errors?.length || json.data === undefined) {
        throw new AdminGraphqlError(`Admin API errors for ${ctx.operation}`, {
          retryable: false,
          details: json.errors,
          logged: true, // the admin.request line above already carried json.errors
        });
      }
      return json.data;
    }
  }

  return { request };
}

let shared: AdminClient | undefined;

/** Process-wide client built from the validated environment. */
export function getAdminClient(): AdminClient {
  if (!shared) {
    const env = getEnv();
    shared = createAdminClient({
      shopDomain: env.shopDomain,
      apiKey: env.shopifyApiKey,
      apiSecret: env.shopifyApiSecret,
    });
  }
  return shared;
}
