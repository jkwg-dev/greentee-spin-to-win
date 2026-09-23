import { getEnv } from "~/config/env.server";
import { SPIN_RESULT_VERSION } from "~/config/campaign";
import { getAdminClient } from "~/lib/admin.server";
import { resolveCampaignMode } from "~/lib/metafields.server";

/**
 * Health check. Reports the effective campaign mode (shop metafield override,
 * else the environment) so the kill switch can be verified without a deploy.
 * Never leaks secrets.
 */
export async function loader() {
  let env;
  try {
    env = getEnv();
  } catch (e) {
    return Response.json(
      { ok: false, error: (e as Error).message.split("\n")[0] },
      { status: 500 },
    );
  }
  // resolveCampaignMode falls back to the environment when the Admin API is unreachable.
  const campaignMode = await resolveCampaignMode(getAdminClient(), env);
  return Response.json({
    ok: true,
    service: "greentee-spin-to-win",
    resultVersion: SPIN_RESULT_VERSION,
    campaignMode,
    campaignModeFromEnv: env.campaignMode,
  });
}
