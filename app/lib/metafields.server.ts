/**
 * Metafield writes and the shop-level campaign mode override.
 */
import { CAMPAIGN_MODES, SPIN_METAFIELD, type CampaignMode } from "~/config/campaign";
import type { AppEnv } from "~/config/env.server";
import type { AdminClient, UserError } from "~/lib/admin.server";
import { log } from "~/lib/log.server";
import type { SpinResultRecord } from "~/lib/spin-result";

export const METAFIELDS_SET_MUTATION = /* GraphQL */ `
  mutation SpinMetafieldsSet($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        id
      }
      userErrors {
        field
        code
        message
      }
    }
  }
`;

export class MetafieldWriteError extends Error {
  readonly retryable = true;
  readonly details: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "MetafieldWriteError";
    this.details = details;
  }
}

interface SetData {
  metafieldsSet: { metafields: Array<{ id: string }> | null; userErrors: UserError[] };
}

/** Upserts the spin result on the order. Idempotent: a second writer writes identical content. */
export async function writeSpinResult(
  admin: AdminClient,
  orderId: string,
  orderGid: string,
  record: SpinResultRecord,
): Promise<string> {
  const data = await admin.request<SetData>(
    METAFIELDS_SET_MUTATION,
    {
      metafields: [
        {
          ownerId: orderGid,
          namespace: SPIN_METAFIELD.namespace,
          key: SPIN_METAFIELD.key,
          type: SPIN_METAFIELD.type,
          value: JSON.stringify(record),
        },
      ],
    },
    { operation: "metafieldsSet", orderId },
  );
  const { userErrors, metafields } = data.metafieldsSet;
  if (userErrors.length > 0 || !metafields?.[0]?.id) {
    log.error("metafield.write.failed", { orderId, userErrors });
    throw new MetafieldWriteError("metafieldsSet returned userErrors", userErrors);
  }
  log.info("metafield.written", { orderId, metafieldId: metafields[0].id });
  return metafields[0].id;
}

/**
 * Shop metafield that lets a non-developer flip the campaign mode from the
 * Shopify admin (Settings > Custom data > Shop) without a deploy. When it is
 * absent or invalid, CAMPAIGN_MODE from the environment applies.
 */
export const CAMPAIGN_MODE_SHOP_METAFIELD = {
  namespace: SPIN_METAFIELD.namespace,
  key: "campaign_mode",
  type: "single_line_text_field",
  name: "Spin to Win campaign mode",
} as const;

export const SHOP_MODE_QUERY = /* GraphQL */ `
  query SpinShopMode($namespace: String!, $key: String!) {
    shop {
      metafield(namespace: $namespace, key: $key) {
        value
      }
    }
  }
`;

interface ShopModeData {
  shop: { metafield: { value: string } | null };
}

const MODE_CACHE_TTL_MS = 30_000;
let modeCache: { at: number; mode: CampaignMode | null } | undefined;

export function clearCampaignModeCache(): void {
  modeCache = undefined;
}

export async function resolveCampaignMode(
  admin: AdminClient,
  env: AppEnv,
  now: () => number = Date.now,
): Promise<CampaignMode> {
  const t = now();
  if (!modeCache || t - modeCache.at >= MODE_CACHE_TTL_MS) {
    let mode: CampaignMode | null = null;
    try {
      const data = await admin.request<ShopModeData>(
        SHOP_MODE_QUERY,
        {
          namespace: CAMPAIGN_MODE_SHOP_METAFIELD.namespace,
          key: CAMPAIGN_MODE_SHOP_METAFIELD.key,
        },
        { operation: "shopCampaignMode" },
      );
      const raw = data.shop.metafield?.value?.trim().toLowerCase();
      if (raw && (CAMPAIGN_MODES as readonly string[]).includes(raw)) {
        mode = raw as CampaignMode;
      } else if (raw) {
        log.warn("campaign_mode.shop_metafield.invalid", { value: raw });
      }
    } catch (error) {
      // Fail closed toward the environment value; never toward "live".
      log.warn("campaign_mode.shop_metafield.unavailable", { error });
    }
    modeCache = { at: t, mode };
  }
  return modeCache.mode ?? env.campaignMode;
}
