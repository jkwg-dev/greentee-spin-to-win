/**
 * One log line per handled request, keyed by order ID, with the HTTP status
 * and the error code when there is one. Together with the domain events this
 * lets one `grep <orderId>` reconstruct a customer's whole story.
 */
import { log } from "~/lib/log.server";

export async function logged(
  route: string,
  orderId: string | null,
  handler: () => Promise<Response>,
): Promise<Response> {
  const started = Date.now();
  const res = await handler();
  let errorCode: string | undefined;
  if (res.status >= 400) {
    try {
      const body = (await res.clone().json()) as { error?: string };
      errorCode = typeof body?.error === "string" ? body.error : undefined;
    } catch {
      /* not JSON */
    }
  }
  log.info("http.request", {
    route,
    ...(orderId ? { orderId } : {}),
    status: res.status,
    ms: Date.now() - started,
    ...(errorCode ? { errorCode } : {}),
  });
  return res;
}
