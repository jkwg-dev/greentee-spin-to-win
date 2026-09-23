/**
 * One-time setup: creates the store-owned metafield definitions.
 *
 *   pnpm setup:metafields
 *
 * - ORDER greentee_spin.result (json): the spin record. Merchant-owned so it
 *   survives app uninstall.
 * - SHOP greentee_spin.campaign_mode (single line text, off|test|live): lets
 *   staff flip the campaign mode from Settings > Custom data without a deploy.
 *
 * Safe to re-run: an existing definition is reported and left alone.
 */
import { SPIN_METAFIELD } from "~/config/campaign";
import { loadEnv } from "~/config/env.server";
import { createAdminClient, type UserError } from "~/lib/admin.server";
import { CAMPAIGN_MODE_SHOP_METAFIELD } from "~/lib/metafields.server";

const CREATE = /* GraphQL */ `
  mutation SpinDefinitionCreate($definition: MetafieldDefinitionInput!) {
    metafieldDefinitionCreate(definition: $definition) {
      createdDefinition {
        id
        namespace
        key
      }
      userErrors {
        field
        code
        message
      }
    }
  }
`;

interface CreateData {
  metafieldDefinitionCreate: {
    createdDefinition: { id: string; namespace: string; key: string } | null;
    userErrors: UserError[];
  };
}

async function main() {
  const env = loadEnv();
  const admin = createAdminClient({
    shopDomain: env.shopDomain,
    apiKey: env.shopifyApiKey,
    apiSecret: env.shopifyApiSecret,
  });

  const definitions = [
    {
      name: SPIN_METAFIELD.name,
      namespace: SPIN_METAFIELD.namespace,
      key: SPIN_METAFIELD.key,
      type: SPIN_METAFIELD.type,
      ownerType: SPIN_METAFIELD.ownerType,
      description: "Spin to Win result for this order (campaign Oct 1 to Nov 2, 2026).",
    },
    {
      name: CAMPAIGN_MODE_SHOP_METAFIELD.name,
      namespace: CAMPAIGN_MODE_SHOP_METAFIELD.namespace,
      key: CAMPAIGN_MODE_SHOP_METAFIELD.key,
      type: CAMPAIGN_MODE_SHOP_METAFIELD.type,
      ownerType: "SHOP",
      description:
        "off, test or live. Overrides the CAMPAIGN_MODE environment variable. Blank = use env.",
      validations: [{ name: "choices", value: JSON.stringify(["off", "test", "live"]) }],
    },
  ];

  for (const definition of definitions) {
    const data = await admin.request<CreateData>(
      CREATE,
      { definition },
      { operation: "metafieldDefinitionCreate" },
    );
    const { createdDefinition, userErrors } = data.metafieldDefinitionCreate;
    const label = `${definition.ownerType} ${definition.namespace}.${definition.key}`;
    if (createdDefinition) {
      console.log(`created ${label} -> ${createdDefinition.id}`);
    } else if (userErrors.some((e) => e.code === "TAKEN")) {
      console.log(`exists  ${label}`);
    } else {
      console.error(`failed  ${label}`, userErrors);
      process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
