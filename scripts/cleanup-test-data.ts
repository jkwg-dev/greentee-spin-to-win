/**
 * Removes test data before launch.
 *
 *   pnpm cleanup:test-data            # dry run: lists what would change
 *   pnpm cleanup:test-data -- --apply # actually deletes
 *
 * 1. Deletes every discount whose title starts with "Spin TEST".
 * 2. Clears the greentee_spin.result metafield from test orders. Candidates
 *    are orders carrying the test tag, plus every order created since
 *    `--since=YYYY-MM-DD` (default 2026-09-01, which covers the whole test
 *    phase; customer-tag testers produce untagged orders, and the app does
 *    not request read_customers). A candidate is only cleared when its stored
 *    record is flagged testMode or uses a GT-TEST- code.
 *
 * Nothing without the test prefix / flag is ever touched.
 */
import { CODE_FORMAT, DISCOUNT_TITLE, SPIN_METAFIELD } from "~/config/campaign";
import { loadEnv } from "~/config/env.server";
import { createAdminClient, type AdminClient, type UserError } from "~/lib/admin.server";
import { parseSpinResult } from "~/lib/spin-result";

const APPLY = process.argv.includes("--apply");
const SINCE =
  process.argv.find((a) => a.startsWith("--since="))?.slice("--since=".length) ?? "2026-09-01";
if (!/^\d{4}-\d{2}-\d{2}$/.test(SINCE)) throw new Error("--since must be YYYY-MM-DD");

const DISCOUNTS = /* GraphQL */ `
  query SpinTestDiscounts($after: String, $query: String) {
    discountNodes(first: 50, after: $after, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        discount {
          ... on DiscountCodeBasic {
            title
          }
        }
      }
    }
  }
`;

const DISCOUNT_DELETE = /* GraphQL */ `
  mutation SpinTestDiscountDelete($id: ID!) {
    discountCodeDelete(id: $id) {
      deletedCodeDiscountId
      userErrors {
        field
        code
        message
      }
    }
  }
`;

const ORDERS = /* GraphQL */ `
  query SpinTestOrders($after: String, $query: String, $namespace: String!, $key: String!) {
    orders(first: 50, after: $after, query: $query) {
      pageInfo {
        hasNextPage
        endCursor
      }
      nodes {
        id
        name
        metafield(namespace: $namespace, key: $key) {
          id
          value
        }
      }
    }
  }
`;

const METAFIELDS_DELETE = /* GraphQL */ `
  mutation SpinTestMetafieldsDelete($metafields: [MetafieldIdentifierInput!]!) {
    metafieldsDelete(metafields: $metafields) {
      deletedMetafields {
        ownerId
        namespace
        key
      }
      userErrors {
        field
        message
      }
    }
  }
`;

interface Page<T> {
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
  nodes: T[];
}

async function* paginate<T>(
  admin: AdminClient,
  query: string,
  rootField: string,
  variables: Record<string, unknown>,
  operation: string,
): AsyncGenerator<T> {
  let after: string | null = null;
  do {
    const data: Record<string, Page<T>> = await admin.request<Record<string, Page<T>>>(
      query,
      { ...variables, after },
      { operation },
    );
    const page: Page<T> = data[rootField];
    for (const node of page.nodes) yield node;
    after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null;
  } while (after);
}

async function cleanDiscounts(admin: AdminClient): Promise<void> {
  const prefix = DISCOUNT_TITLE.testPrefix;
  let seen = 0;
  let deleted = 0;
  for await (const node of paginate<{ id: string; discount: { title?: string } }>(
    admin,
    DISCOUNTS,
    "discountNodes",
    { query: `title:${JSON.stringify(prefix + "*")}` },
    "discountNodes",
  )) {
    const title = node.discount?.title ?? "";
    if (!title.startsWith(prefix)) continue; // hard guard, independent of the search filter
    seen++;
    console.log(`${APPLY ? "delete" : "would delete"} discount ${node.id}  "${title}"`);
    if (!APPLY) continue;
    const data = await admin.request<{
      discountCodeDelete: { deletedCodeDiscountId: string | null; userErrors: UserError[] };
    }>(DISCOUNT_DELETE, { id: node.id }, { operation: "discountCodeDelete" });
    if (data.discountCodeDelete.userErrors.length)
      console.error("  failed", data.discountCodeDelete.userErrors);
    else deleted++;
  }
  console.log(`discounts: ${seen} matched "${prefix}", ${deleted} deleted`);
}

function isTestRecord(value: string | undefined): boolean {
  if (!value) return false;
  try {
    const rec = parseSpinResult(value);
    return !!rec && (rec.testMode || (rec.code ?? "").startsWith(CODE_FORMAT.testDiscountPrefix));
  } catch {
    return false;
  }
}

async function cleanOrders(admin: AdminClient, testTag: string): Promise<void> {
  const targets = new Map<string, string>(); // orderId -> name
  const vars = { namespace: SPIN_METAFIELD.namespace, key: SPIN_METAFIELD.key };
  type OrderNode = { id: string; name: string; metafield: { id: string; value: string } | null };

  const consider = (o: OrderNode) => {
    if (o.metafield && isTestRecord(o.metafield.value)) targets.set(o.id, o.name);
  };

  for await (const o of paginate<OrderNode>(
    admin,
    ORDERS,
    "orders",
    { ...vars, query: `tag:${testTag}` },
    "orders",
  ))
    consider(o);

  for await (const o of paginate<OrderNode>(
    admin,
    ORDERS,
    "orders",
    { ...vars, query: `created_at:>=${SINCE}` },
    "orders",
  ))
    consider(o);

  for (const [id, name] of targets)
    console.log(`${APPLY ? "clear" : "would clear"} metafield on order ${name} (${id})`);
  console.log(`orders: ${targets.size} test spin records${APPLY ? "" : " (dry run)"}`);
  if (!APPLY || targets.size === 0) return;

  const ids = [...targets.keys()];
  for (let i = 0; i < ids.length; i += 25) {
    const batch = ids.slice(i, i + 25).map((ownerId) => ({ ownerId, ...vars }));
    const data = await admin.request<{
      metafieldsDelete: { deletedMetafields: unknown[]; userErrors: UserError[] };
    }>(METAFIELDS_DELETE, { metafields: batch }, { operation: "metafieldsDelete" });
    if (data.metafieldsDelete.userErrors.length)
      console.error("  failed", data.metafieldsDelete.userErrors);
    else console.log(`  cleared ${data.metafieldsDelete.deletedMetafields.length}`);
  }
}

async function main() {
  const env = loadEnv();
  const admin = createAdminClient({
    shopDomain: env.shopDomain,
    apiKey: env.shopifyApiKey,
    apiSecret: env.shopifyApiSecret,
  });
  console.log(APPLY ? "APPLY mode: changes will be made" : "DRY RUN: pass --apply to make changes");
  await cleanDiscounts(admin);
  await cleanOrders(admin, env.testTag);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
