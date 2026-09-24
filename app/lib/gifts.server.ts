/**
 * Gift issuance through the Order Editing API.
 *
 * Flow (see CLAUDE.md, "Gift rewards"):
 *   spin  -> record { gift.status: "pending" } and tag the order gift-pending
 *   confirm -> pick the variant (customer's size + the colour with most stock)
 *           -> orderEditBegin / AddVariant / AddLineItemDiscount 100% / Commit
 *           -> record { status: "added", variantId, lineItemId } -> tag gift-added
 *
 * Stock rule: a variant counts only when availableForSale and
 * inventoryQuantity > 0. Negative inventory (oversells) is excluded. If
 * nothing is available the order is not edited, the record says
 * "unavailable" with a reason, and the tag stays gift-pending for staff.
 * Never substitute another product.
 */
import { GIFT_LINE_DISCOUNT, GIFT_TAGS, type GiftProduct } from "~/config/campaign";
import type { AdminClient, UserError } from "~/lib/admin.server";
import { log } from "~/lib/log.server";

/* --------------------------------------------------------------- types */

export interface VariantStock {
  readonly id: string;
  readonly title: string;
  readonly availableForSale: boolean;
  readonly inventoryQuantity: number;
  /** Option name (lower-cased) -> value. */
  readonly options: Readonly<Record<string, string>>;
}

export interface GiftOption {
  readonly name: string;
  /** Every value the product has for this option, in display order. */
  readonly values: readonly string[];
}

export interface GiftCombination {
  /** One value per customer option, e.g. { Hand: "LH", Size: "22" }. */
  readonly selection: Readonly<Record<string, string>>;
  /** Total available stock behind this combination. */
  readonly stock: number;
}

/** What the spin page needs to render the gift step. */
export interface GiftOffer {
  readonly rewardKey: GiftProduct["rewardKey"];
  readonly productTitle: string;
  /** Product image from Shopify, or null. */
  readonly imageUrl: string | null;
  readonly note: string;
  /** Options the customer chooses, in display order. Empty when nothing to choose. */
  readonly options: readonly GiftOption[];
  /**
   * Combinations backed by an in-stock variant. The page enables a value only
   * when a combination exists with it and the other current choices, so out of
   * stock combinations are disabled rather than whole values.
   */
  readonly combinations: readonly GiftCombination[];
  /** The available combination with most stock, or null. Never a fixed value. */
  readonly preselect: Readonly<Record<string, string>> | null;
  readonly anyAvailable: boolean;
}

export class GiftEditError extends Error {
  readonly retryable = true;
  readonly details: unknown;
  constructor(message: string, details?: unknown) {
    super(message);
    this.name = "GiftEditError";
    this.details = details;
  }
}

/* --------------------------------------------------------- pure rules */

function key(name: string): string {
  return name.trim().toLowerCase();
}

/** The stock rule. Oversold (negative) and unpublished variants never count. */
export function isAvailable(v: VariantStock): boolean {
  return (
    v.availableForSale === true && Number.isFinite(v.inventoryQuantity) && v.inventoryQuantity > 0
  );
}

export function matchesOptions(v: VariantStock, wanted: Readonly<Record<string, string>>): boolean {
  return Object.entries(wanted).every(
    ([name, value]) => (v.options[key(name)] ?? "").toLowerCase() === value.trim().toLowerCase(),
  );
}

function compareValue(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

/** Builds the customer-facing offer: the options, which combinations are in stock, and a default. */
export function buildOffer(
  product: GiftProduct,
  variants: readonly VariantStock[],
  imageUrl: string | null = null,
): GiftOffer {
  const fixed = variants.filter((v) => matchesOptions(v, product.fixedOptions));
  const base = {
    rewardKey: product.rewardKey,
    productTitle: product.title,
    imageUrl,
    note: product.note,
  };
  if (product.customerOptions.length === 0) {
    return {
      ...base,
      options: [],
      combinations: [],
      preselect: null,
      anyAvailable: fixed.some(isAvailable),
    };
  }
  const names = product.customerOptions;
  const valueSets = names.map(() => new Set<string>());
  const combos = new Map<string, { selection: Record<string, string>; stock: number }>();
  for (const v of fixed) {
    const selection: Record<string, string> = {};
    let complete = true;
    names.forEach((name, i) => {
      const value = v.options[key(name)];
      if (value === undefined) complete = false;
      else {
        selection[name] = value;
        valueSets[i].add(value);
      }
    });
    if (!complete || !isAvailable(v)) continue;
    const id = names.map((n) => selection[n]).join("\u0000");
    const entry = combos.get(id) ?? { selection, stock: 0 };
    entry.stock += v.inventoryQuantity;
    combos.set(id, entry);
  }
  const options: GiftOption[] = names.map((name, i) => ({
    name,
    values: [...valueSets[i]].sort(compareValue),
  }));
  const combinations: GiftCombination[] = [...combos.values()];
  let preselect: GiftCombination | null = null;
  for (const c of combinations) if (!preselect || c.stock > preselect.stock) preselect = c;
  return {
    ...base,
    options,
    combinations,
    preselect: preselect ? preselect.selection : null,
    anyAvailable: combinations.length > 0,
  };
}

export type PickResult =
  | { ok: true; variant: VariantStock }
  | { ok: false; reason: "no_stock" | "invalid_selection" | "selection_required" };

/**
 * Resolves the variant to add: the fixed options, every customer option from
 * the selection, then the available variant with the most stock (which is how
 * a picked option such as colour resolves; ties go to catalogue order).
 */
export function pickVariant(
  product: GiftProduct,
  variants: readonly VariantStock[],
  selection: Readonly<Record<string, string>> | null,
): PickResult {
  const wanted: Record<string, string> = { ...product.fixedOptions };
  for (const name of product.customerOptions) {
    const chosen = selection?.[name] ?? selection?.[key(name)];
    if (!chosen) return { ok: false, reason: "selection_required" };
    const known = variants.some(
      (v) => (v.options[key(name)] ?? "").toLowerCase() === chosen.trim().toLowerCase(),
    );
    if (!known) return { ok: false, reason: "invalid_selection" };
    wanted[name] = chosen;
  }
  const candidates = variants.filter((v) => matchesOptions(v, wanted) && isAvailable(v));
  if (candidates.length === 0) return { ok: false, reason: "no_stock" };
  let best = candidates[0];
  for (const c of candidates) if (c.inventoryQuantity > best.inventoryQuantity) best = c;
  return { ok: true, variant: best };
}

/* ------------------------------------------------------------ queries */

export const GIFT_PRODUCT_QUERY = /* GraphQL */ `
  query SpinGiftProduct($id: ID!) {
    product(id: $id) {
      id
      title
      featuredImage {
        url(transform: { maxWidth: 600, maxHeight: 600 })
      }
      variants(first: 100) {
        nodes {
          id
          title
          availableForSale
          inventoryQuantity
          selectedOptions {
            name
            value
          }
        }
      }
    }
  }
`;

interface ProductData {
  product: {
    id: string;
    title: string;
    featuredImage: { url: string } | null;
    variants: {
      nodes: Array<{
        id: string;
        title: string;
        availableForSale: boolean;
        inventoryQuantity: number | null;
        selectedOptions: Array<{ name: string; value: string }>;
      }>;
    };
  } | null;
}

export interface GiftProductData {
  readonly variants: VariantStock[];
  readonly imageUrl: string | null;
}

export async function loadGiftProduct(
  admin: AdminClient,
  product: GiftProduct,
  orderId: string,
): Promise<GiftProductData> {
  const data = await admin.request<ProductData>(
    GIFT_PRODUCT_QUERY,
    { id: product.productId },
    { operation: "giftProduct", orderId },
  );
  if (!data.product) throw new GiftEditError(`Gift product ${product.productId} not found`);
  return {
    imageUrl: data.product.featuredImage?.url ?? null,
    variants: data.product.variants.nodes.map((v) => ({
      id: v.id,
      title: v.title,
      availableForSale: v.availableForSale,
      inventoryQuantity: v.inventoryQuantity ?? 0,
      options: Object.fromEntries(v.selectedOptions.map((o) => [key(o.name), o.value])),
    })),
  };
}

export const ORDER_LINES_QUERY = /* GraphQL */ `
  query SpinOrderLines($id: ID!) {
    order(id: $id) {
      id
      lineItems(first: 100) {
        nodes {
          id
          quantity
          variant {
            id
            product {
              id
            }
          }
          originalTotalSet {
            shopMoney {
              amount
            }
          }
          discountedTotalSet {
            shopMoney {
              amount
            }
          }
        }
      }
    }
  }
`;

interface LinesData {
  order: {
    lineItems: {
      nodes: Array<{
        id: string;
        quantity: number;
        variant: { id: string; product: { id: string } | null } | null;
        originalTotalSet: { shopMoney: { amount: string } };
        discountedTotalSet: { shopMoney: { amount: string } };
      }>;
    };
  } | null;
}

export interface GiftLine {
  readonly lineItemId: string;
  readonly variantId: string;
}

/**
 * Finds a gift line already on the order: a line of the gift product that is
 * fully discounted. Used for idempotent replay after a crash between commit
 * and the metafield write, and to find the committed line's real ID.
 */
export async function findGiftLine(
  admin: AdminClient,
  orderGid: string,
  orderId: string,
  productId: string,
  variantId?: string,
): Promise<GiftLine | null> {
  const data = await admin.request<LinesData>(
    ORDER_LINES_QUERY,
    { id: orderGid },
    { operation: "orderLines", orderId },
  );
  const lines = data.order?.lineItems.nodes ?? [];
  const matches = lines.filter((l) => {
    if (!l.variant || l.variant.product?.id !== productId) return false;
    if (variantId && l.variant.id !== variantId) return false;
    const original = Number(l.originalTotalSet.shopMoney.amount);
    const discounted = Number(l.discountedTotalSet.shopMoney.amount);
    return original > 0 && discounted === 0;
  });
  const last = matches[matches.length - 1];
  return last ? { lineItemId: last.id, variantId: last.variant!.id } : null;
}

/* ------------------------------------------------------ order editing */

const EDIT_BEGIN = /* GraphQL */ `
  mutation SpinOrderEditBegin($id: ID!) {
    orderEditBegin(id: $id) {
      calculatedOrder {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const EDIT_ADD_VARIANT = /* GraphQL */ `
  mutation SpinOrderEditAddVariant($id: ID!, $variantId: ID!) {
    orderEditAddVariant(id: $id, variantId: $variantId, quantity: 1, allowDuplicates: true) {
      calculatedLineItem {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const EDIT_ADD_DISCOUNT = /* GraphQL */ `
  mutation SpinOrderEditAddLineItemDiscount(
    $id: ID!
    $lineItemId: ID!
    $discount: OrderEditAppliedDiscountInput!
  ) {
    orderEditAddLineItemDiscount(id: $id, lineItemId: $lineItemId, discount: $discount) {
      addedDiscountStagedChange {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const EDIT_COMMIT = /* GraphQL */ `
  mutation SpinOrderEditCommit($id: ID!, $staffNote: String) {
    orderEditCommit(id: $id, notifyCustomer: false, staffNote: $staffNote) {
      order {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const TAGS_ADD = /* GraphQL */ `
  mutation SpinTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors {
        field
        message
      }
    }
  }
`;

const TAGS_REMOVE = /* GraphQL */ `
  mutation SpinTagsRemove($id: ID!, $tags: [String!]!) {
    tagsRemove(id: $id, tags: $tags) {
      userErrors {
        field
        message
      }
    }
  }
`;

function failIfErrors(
  operation: string,
  orderId: string,
  errors: UserError[] | undefined,
  payload: unknown,
): void {
  if (errors && errors.length > 0) {
    log.error("gift.edit.user_errors", { orderId, operation, userErrors: errors, payload });
    throw new GiftEditError(`${operation} returned userErrors`, errors);
  }
}

export interface AddGiftInput {
  readonly orderId: string;
  readonly orderGid: string;
  readonly variant: VariantStock;
  readonly product: GiftProduct;
  readonly reference: string;
}

export interface AddedGift {
  readonly orderEditId: string;
  readonly lineItemId: string | null;
}

/** Adds the variant at 100% off and commits without notifying the customer. */
export async function addGiftToOrder(admin: AdminClient, input: AddGiftInput): Promise<AddedGift> {
  const ctx = (operation: string) => ({ operation, orderId: input.orderId });

  const begin = await admin.request<{
    orderEditBegin: { calculatedOrder: { id: string } | null; userErrors: UserError[] };
  }>(EDIT_BEGIN, { id: input.orderGid }, ctx("orderEditBegin"));
  failIfErrors("orderEditBegin", input.orderId, begin.orderEditBegin.userErrors, begin);
  const calcId = begin.orderEditBegin.calculatedOrder?.id;
  if (!calcId) throw new GiftEditError("orderEditBegin returned no calculated order");

  const add = await admin.request<{
    orderEditAddVariant: { calculatedLineItem: { id: string } | null; userErrors: UserError[] };
  }>(EDIT_ADD_VARIANT, { id: calcId, variantId: input.variant.id }, ctx("orderEditAddVariant"));
  failIfErrors("orderEditAddVariant", input.orderId, add.orderEditAddVariant.userErrors, add);
  const calcLineId = add.orderEditAddVariant.calculatedLineItem?.id;
  if (!calcLineId) throw new GiftEditError("orderEditAddVariant returned no line item");

  const disc = await admin.request<{ orderEditAddLineItemDiscount: { userErrors: UserError[] } }>(
    EDIT_ADD_DISCOUNT,
    {
      id: calcId,
      lineItemId: calcLineId,
      discount: {
        percentValue: GIFT_LINE_DISCOUNT.percentValue,
        description: GIFT_LINE_DISCOUNT.description,
      },
    },
    ctx("orderEditAddLineItemDiscount"),
  );
  failIfErrors(
    "orderEditAddLineItemDiscount",
    input.orderId,
    disc.orderEditAddLineItemDiscount.userErrors,
    disc,
  );

  const commit = await admin.request<{
    orderEditCommit: { order: { id: string } | null; userErrors: UserError[] };
  }>(
    EDIT_COMMIT,
    {
      id: calcId,
      staffNote: `Spin to Win gift ${input.reference}: ${input.product.title} (${input.variant.title})`,
    },
    ctx("orderEditCommit"),
  );
  failIfErrors("orderEditCommit", input.orderId, commit.orderEditCommit.userErrors, commit);

  // The committed line's real ID is not on the commit payload; read it back.
  const line = await findGiftLine(
    admin,
    input.orderGid,
    input.orderId,
    input.product.productId,
    input.variant.id,
  );
  log.info("gift.added", {
    orderId: input.orderId,
    variantId: input.variant.id,
    lineItemId: line?.lineItemId ?? null,
    orderEditId: calcId,
  });
  return { orderEditId: calcId, lineItemId: line?.lineItemId ?? null };
}

export async function tagGiftPending(
  admin: AdminClient,
  orderGid: string,
  orderId: string,
): Promise<void> {
  const data = await admin.request<{ tagsAdd: { userErrors: UserError[] } }>(
    TAGS_ADD,
    { id: orderGid, tags: [GIFT_TAGS.pending] },
    { operation: "tagsAdd", orderId },
  );
  failIfErrors("tagsAdd", orderId, data.tagsAdd.userErrors, data);
}

/** Flips gift-pending to gift-added. Add first so the order is never untagged. */
export async function tagGiftAdded(
  admin: AdminClient,
  orderGid: string,
  orderId: string,
): Promise<void> {
  const added = await admin.request<{ tagsAdd: { userErrors: UserError[] } }>(
    TAGS_ADD,
    { id: orderGid, tags: [GIFT_TAGS.added] },
    { operation: "tagsAdd", orderId },
  );
  failIfErrors("tagsAdd", orderId, added.tagsAdd.userErrors, added);
  const removed = await admin.request<{ tagsRemove: { userErrors: UserError[] } }>(
    TAGS_REMOVE,
    { id: orderGid, tags: [GIFT_TAGS.pending] },
    { operation: "tagsRemove", orderId },
  );
  failIfErrors("tagsRemove", orderId, removed.tagsRemove.userErrors, removed);
}
