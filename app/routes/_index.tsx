import { getEnv } from "~/config/env.server";
import { SPIN_RESULT_VERSION } from "~/config/campaign";

/**
 * Health check. Reports the campaign mode so the kill switch can be verified
 * without a deploy. Never leaks secrets.
 */
export function loader() {
  let campaignMode: string;
  try {
    campaignMode = getEnv().campaignMode;
  } catch (e) {
    return Response.json(
      { ok: false, error: (e as Error).message.split("\n")[0] },
      { status: 500 },
    );
  }
  return Response.json({
    ok: true,
    service: "greentee-spin-to-win",
    resultVersion: SPIN_RESULT_VERSION,
    campaignMode,
  });
}
