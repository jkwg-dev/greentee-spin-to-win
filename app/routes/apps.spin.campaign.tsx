/**
 * GET /apps/spin/campaign   (via the Shopify app proxy)
 *
 * Tells the cart progress bar whether the wheel is on and what the threshold
 * is. No token: this is public, per-store information. Cached for a minute
 * so a busy cart drawer does not hammer the Admin API for the mode.
 */
import type { LoaderFunctionArgs } from "react-router";
import { getEnv } from "~/config/env.server";
import { getAdminClient } from "~/lib/admin.server";
import { cartProgressConfig } from "~/lib/cart-progress.server";
import { log } from "~/lib/log.server";
import { resolveCampaignMode } from "~/lib/metafields.server";
import { guardProxySignature } from "~/lib/proxy-route.server";
import { logged } from "~/lib/request-log.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const env = getEnv();
  const guard = guardProxySignature(request, env);
  if (!guard.ok) return guard.response;

  return logged("apps.spin.campaign", null, async () => {
    let mode = env.campaignMode;
    try {
      mode = await resolveCampaignMode(getAdminClient(), env);
    } catch (error) {
      // The resolver already fails toward the environment value; belt and braces.
      log.warn("campaign.mode_unavailable", { error });
    }
    const body = cartProgressConfig(mode, env, new Date());
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "public, max-age=60",
      },
    });
  });
}
