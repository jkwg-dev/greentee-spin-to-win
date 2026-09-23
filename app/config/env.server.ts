/**
 * Typed, validated view of the environment. Read once and memoised.
 *
 * Every knob that CLAUDE.md lists under "Configuration" is parsed here so the
 * rest of the server never touches process.env directly. Anything that is
 * wrong fails fast at boot with every problem listed, not just the first.
 */
import {
  CAMPAIGN_DEFAULTS,
  CAMPAIGN_MODES,
  CAMPAIGN_TIMEZONE,
  DEFAULT_SPIN_PAGE_PATH,
  type CampaignMode,
  type DiscountCollectionKey,
} from "~/config/campaign";
import { parseInZone } from "~/lib/time";

export interface AppEnv {
  /** off | test | live. `off` is the kill switch. */
  readonly campaignMode: CampaignMode;
  readonly campaignStart: Date;
  readonly campaignEnd: Date;
  readonly minSubtotalCad: number;
  /** Lower-cased and trimmed, ready for case-insensitive tag comparison. */
  readonly testTag: string;
  /** Lower-cased and trimmed. */
  readonly testEmails: ReadonlySet<string>;
  readonly testBypassMinSubtotal: boolean;
  readonly collections: Readonly<Record<DiscountCollectionKey, string>>;
  readonly spinSecret: string;
  /** Public URL of this server. Optional: nothing server-side depends on it at boot. */
  readonly appUrl: string | undefined;
  /** Absolute URL of the storefront page holding the wheel block (no query string). */
  readonly spinPageUrl: string;
  /** Shopify app credentials (Dev Dashboard client ID and secret). */
  readonly shopifyApiKey: string;
  readonly shopifyApiSecret: string;
  /** The single store this app serves, e.g. greentee-golf.myshopify.com. */
  readonly shopDomain: string;
  /**
   * Extra hosts accepted as the shop in extension session tokens (`dest`), for
   * example the primary storefront domain. Lower-cased. Safety valve only.
   */
  readonly shopAltDomains: ReadonlySet<string>;
}

export type EnvSource = Readonly<Record<string, string | undefined>>;

const COLLECTION_GID = /^gid:\/\/shopify\/Collection\/\d+$/;

function str(source: EnvSource, key: string): string | undefined {
  const v = source[key];
  if (v === undefined) return undefined;
  const t = v.trim();
  return t === "" ? undefined : t;
}

function bool(source: EnvSource, key: string, fallback: boolean, problems: string[]): boolean {
  const v = str(source, key);
  if (v === undefined) return fallback;
  const lower = v.toLowerCase();
  if (["true", "1", "yes", "on"].includes(lower)) return true;
  if (["false", "0", "no", "off"].includes(lower)) return false;
  problems.push(`${key} must be true or false, got "${v}"`);
  return fallback;
}

/** Normalises a tag or email for comparison: trim, collapse case. */
export function normalizeTag(value: string): string {
  return value.trim().toLowerCase();
}

export function loadEnv(source: EnvSource = process.env): AppEnv {
  const problems: string[] = [];

  const modeRaw = str(source, "CAMPAIGN_MODE") ?? "off";
  const campaignMode = (CAMPAIGN_MODES as readonly string[]).includes(modeRaw)
    ? (modeRaw as CampaignMode)
    : (problems.push(`CAMPAIGN_MODE must be one of ${CAMPAIGN_MODES.join(", ")}, got "${modeRaw}"`),
      "off");

  const parseDate = (key: string, fallback: string): Date => {
    const raw = str(source, key) ?? fallback;
    try {
      return parseInZone(raw, CAMPAIGN_TIMEZONE);
    } catch (e) {
      problems.push(`${key}: ${(e as Error).message}`);
      return new Date(0);
    }
  };
  const campaignStart = parseDate("CAMPAIGN_START", CAMPAIGN_DEFAULTS.start);
  const campaignEnd = parseDate("CAMPAIGN_END", CAMPAIGN_DEFAULTS.end);
  if (campaignEnd <= campaignStart) problems.push("CAMPAIGN_END must be after CAMPAIGN_START");

  const minRaw = str(source, "MIN_SUBTOTAL_CAD");
  const minSubtotalCad = minRaw === undefined ? CAMPAIGN_DEFAULTS.minSubtotalCad : Number(minRaw);
  if (!Number.isFinite(minSubtotalCad) || minSubtotalCad < 0) {
    problems.push(`MIN_SUBTOTAL_CAD must be a non-negative number, got "${minRaw}"`);
  }

  const testTag = normalizeTag(str(source, "TEST_TAG") ?? CAMPAIGN_DEFAULTS.testTag);
  const testEmails = new Set(
    (str(source, "TEST_EMAILS") ?? "")
      .split(",")
      .map(normalizeTag)
      .filter((e) => e !== ""),
  );
  const testBypassMinSubtotal = bool(source, "TEST_BYPASS_MIN_SUBTOTAL", false, problems);

  const collectionKeys: Record<DiscountCollectionKey, string> = {
    clubs: "COLLECTION_CLUBS",
    accessories: "COLLECTION_ACCESSORIES",
    apparel: "COLLECTION_APPAREL",
  };
  const collections = {} as Record<DiscountCollectionKey, string>;
  for (const [key, envKey] of Object.entries(collectionKeys) as [DiscountCollectionKey, string][]) {
    const v = str(source, envKey);
    if (!v) problems.push(`${envKey} is required`);
    else if (!COLLECTION_GID.test(v))
      problems.push(`${envKey} must be a Collection GID, got "${v}"`);
    collections[key] = v ?? "";
  }

  const spinSecret = str(source, "SPIN_SECRET") ?? "";
  if (spinSecret.length < 16)
    problems.push("SPIN_SECRET is required and must be at least 16 characters");

  // The Shopify CLI injects SHOPIFY_APP_URL during `shopify app dev`; APP_URL wins when set.
  // Optional so development boots before the production URL exists.
  const appUrl = str(source, "APP_URL") ?? str(source, "SHOPIFY_APP_URL");
  if (appUrl !== undefined && !/^https?:\/\//.test(appUrl)) {
    problems.push("APP_URL (or SHOPIFY_APP_URL) must be an absolute URL when set");
  }

  const shopifyApiKey = str(source, "SHOPIFY_API_KEY") ?? "";
  if (!shopifyApiKey) problems.push("SHOPIFY_API_KEY is required");
  const shopifyApiSecret = str(source, "SHOPIFY_API_SECRET") ?? "";
  if (!shopifyApiSecret) problems.push("SHOPIFY_API_SECRET is required");
  const shopDomain = (str(source, "SHOP_DOMAIN") ?? "").toLowerCase();
  if (!/^[a-z0-9-]+\.myshopify\.com$/.test(shopDomain)) {
    problems.push("SHOP_DOMAIN must be the store's *.myshopify.com domain");
  }

  const shopAltDomains = new Set(
    (str(source, "SHOP_ALT_DOMAINS") ?? "")
      .split(",")
      .map((d) =>
        d
          .trim()
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/\/.*$/, ""),
      )
      .filter((d) => d !== ""),
  );

  // Where the Thank you page sends customers to spin. Defaults to the
  // myshopify domain; set it to the primary storefront domain in production.
  const spinPageUrl =
    str(source, "SPIN_PAGE_URL") ?? `https://${shopDomain}${DEFAULT_SPIN_PAGE_PATH}`;
  if (!/^https?:\/\//.test(spinPageUrl) || spinPageUrl.includes("?")) {
    problems.push("SPIN_PAGE_URL must be an absolute URL without a query string");
  }

  if (problems.length > 0) {
    throw new Error(`Invalid environment:\n - ${problems.join("\n - ")}`);
  }

  return {
    campaignMode,
    campaignStart,
    campaignEnd,
    minSubtotalCad,
    testTag,
    testEmails,
    testBypassMinSubtotal,
    collections,
    spinSecret,
    appUrl: appUrl?.replace(/\/+$/, ""),
    spinPageUrl: spinPageUrl.replace(/\/+$/, ""),
    shopifyApiKey,
    shopifyApiSecret,
    shopDomain,
    shopAltDomains,
  };
}

let cached: AppEnv | undefined;

/** Memoised environment. Throws on first call if the environment is invalid. */
export function getEnv(): AppEnv {
  cached ??= loadEnv();
  return cached;
}

/** Test hook. */
export function resetEnvCache(): void {
  cached = undefined;
}
