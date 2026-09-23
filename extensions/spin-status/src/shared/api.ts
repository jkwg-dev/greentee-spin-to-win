/**
 * Client for POST {appUrl}/api/spin/status. Pure parsing lives here so it
 * can be unit tested without the extension runtime.
 */

export interface PublicSpinResult {
  readonly sliceIndex: number;
  readonly rewardKey: string;
  readonly rewardLabel: string;
  readonly rewardType: "discount" | "gift";
  readonly code: string | null;
  readonly gift: { readonly variantId: string; readonly reference: string } | null;
  readonly spunAt: string;
  readonly expiresAt: string;
  readonly expired: boolean;
  readonly testMode: boolean;
}

export type SpinView =
  | { readonly kind: "closed" }
  | { readonly kind: "pending" }
  | { readonly kind: "eligible"; readonly spinUrl: string | null; readonly testMode: boolean }
  | { readonly kind: "ineligible"; readonly message: string; readonly testMode: boolean }
  | { readonly kind: "spun"; readonly result: PublicSpinResult; readonly testMode: boolean }
  | { readonly kind: "error"; readonly retryable: boolean; readonly detail: string };

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object";
}

/** Maps the server's status payload onto a view state. Unknown shapes become a retryable error. */
export function parseStatus(body: unknown): SpinView {
  if (!isRecord(body)) return { kind: "error", retryable: true, detail: "malformed" };
  if (body.campaignOpen === false) return { kind: "closed" };
  if (body.campaignOpen !== true) return { kind: "error", retryable: true, detail: "malformed" };
  if (body.pending === true) return { kind: "pending" };
  const testMode = body.testMode === true;
  if (body.alreadySpun === true && isRecord(body.result)) {
    const r = body.result;
    if (typeof r.rewardLabel !== "string" || typeof r.expiresAt !== "string") {
      return { kind: "error", retryable: false, detail: "malformed result" };
    }
    return {
      kind: "spun",
      testMode,
      result: {
        sliceIndex: Number(r.sliceIndex),
        rewardKey: String(r.rewardKey ?? ""),
        rewardLabel: r.rewardLabel,
        rewardType: r.rewardType === "gift" ? "gift" : "discount",
        code: typeof r.code === "string" ? r.code : null,
        gift: isRecord(r.gift)
          ? { variantId: String(r.gift.variantId ?? ""), reference: String(r.gift.reference ?? "") }
          : null,
        spunAt: String(r.spunAt ?? ""),
        expiresAt: r.expiresAt,
        expired: r.expired === true,
        testMode: r.testMode === true,
      },
    };
  }
  if (body.eligible === true) {
    return {
      kind: "eligible",
      spinUrl: typeof body.spinUrl === "string" ? body.spinUrl : null,
      testMode,
    };
  }
  if (body.eligible === false) {
    return {
      kind: "ineligible",
      message: typeof body.message === "string" ? body.message : "",
      testMode,
    };
  }
  return { kind: "error", retryable: true, detail: "malformed" };
}

export interface StatusRequest {
  readonly appUrl: string;
  readonly orderId: string;
  readonly getSessionToken: () => Promise<string>;
  readonly fetchImpl?: typeof fetch;
}

export async function fetchStatus(req: StatusRequest): Promise<SpinView> {
  const fetchImpl = req.fetchImpl ?? fetch;
  let token: string;
  try {
    token = await req.getSessionToken();
  } catch {
    return { kind: "error", retryable: true, detail: "session token" };
  }
  let res: Response;
  try {
    res = await fetchImpl(`${req.appUrl.replace(/\/+$/, "")}/api/spin/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ orderId: req.orderId }),
    });
  } catch {
    return { kind: "error", retryable: true, detail: "network" };
  }
  if (res.status === 401 || res.status === 403 || res.status === 400) {
    // Misconfiguration, not something a retry fixes.
    return { kind: "error", retryable: false, detail: `http ${res.status}` };
  }
  if (!res.ok) return { kind: "error", retryable: res.status >= 500, detail: `http ${res.status}` };
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { kind: "error", retryable: true, detail: "invalid json" };
  }
  return parseStatus(body);
}

/** Delays between polls while the order is still being created (about 20 seconds in total). */
export const PENDING_DELAYS_MS: readonly number[] = [1500, 2500, 4000, 6000, 8000];

/** Delays between automatic retries after a retryable error. */
export const ERROR_RETRY_DELAYS_MS: readonly number[] = [2000, 5000];
