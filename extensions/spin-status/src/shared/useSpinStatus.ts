import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import { ERROR_RETRY_DELAYS_MS, PENDING_DELAYS_MS, fetchStatus, type SpinView } from "./api";

export interface SpinEnv {
  /** Order GID from the target API, or null while it is not available yet. */
  readonly orderId: string | null;
  /** Base URL of the app server from the extension settings, or null if unset. */
  readonly appUrl: string | null;
  readonly getSessionToken: () => Promise<string>;
}

export type LoadState = { readonly kind: "loading" } | SpinView;

/**
 * Loads the spin status, polling while the order is still being created and
 * retrying a couple of times after transient failures. `reload` forces a
 * fresh load (used by the Try again button).
 */
export function useSpinStatus(env: SpinEnv): { state: LoadState; reload: () => void } {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [generation, setGeneration] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const reload = useCallback(() => setGeneration((g) => g + 1), []);

  useEffect(() => {
    let cancelled = false;
    const { orderId, appUrl } = env;
    if (!appUrl) {
      console.error("[spin] app_url setting is not configured");
      setState({ kind: "error", retryable: false, detail: "app_url missing" });
      return;
    }
    if (!orderId) {
      setState({ kind: "loading" });
      return;
    }

    let pendingPolls = 0;
    let errorRetries = 0;
    setState({ kind: "loading" });

    const schedule = (ms: number) => {
      timer.current = setTimeout(run, ms);
    };

    async function run() {
      const view = await fetchStatus({
        appUrl: appUrl!,
        orderId: orderId!,
        getSessionToken: env.getSessionToken,
      });
      if (cancelled) return;
      if (view.kind === "pending") {
        const delay = PENDING_DELAYS_MS[pendingPolls];
        pendingPolls += 1;
        if (delay !== undefined) {
          setState({ kind: "pending" });
          schedule(delay);
          return;
        }
        // Out of patience: surface as retryable so the customer can try again.
        setState({ kind: "error", retryable: true, detail: "still pending" });
        return;
      }
      if (view.kind === "error" && view.retryable) {
        const delay = ERROR_RETRY_DELAYS_MS[errorRetries];
        errorRetries += 1;
        if (delay !== undefined) {
          schedule(delay);
          return;
        }
      }
      if (view.kind === "error") console.error("[spin] status failed:", view.detail);
      setState(view);
    }

    void run();
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
    // getSessionToken is stable per extension instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [env.orderId, env.appUrl, generation]);

  return { state, reload };
}

/** Reads and normalises the app_url setting. */
export function appUrlFromSettings(settings: Record<string, unknown> | undefined): string | null {
  const raw = settings?.app_url;
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return /^https?:\/\//.test(trimmed) ? trimmed : null;
}
