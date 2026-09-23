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

export interface GiftChoice {
  readonly value: string;
  readonly available: boolean;
  /** Total stock across colours for this value. */
  readonly stock: number;
}

/** What the spin page needs to render the gift step. */
export interface GiftOffer {
  readonly rewardKey: GiftProduct["rewardKey"];
  readonly productTitle: string;
  /** Product image from Shopify, or null. */
  readonly imageUrl: string | null;
  readonly note: string;
  /** Option the customer picks, e.g. "Size", or null when nothing to choose. */
  readonly customerOption: string | null;
  readonly choices: readonly GiftChoice[] | null;
  /** An in-stock choice to preselect (the one with most stock), or null. */
  readonly preselect: string | null;
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

function compareChoice(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a.localeCompare(b);
}

/** Builds the customer-facing offer: which values can be chosen and which are sold out. */
export function buildOffer(
  product: GiftProduct,
  variants: readonly VariantStock[],
  imageUrl: string | null = null,
): GiftOffer {
  const fixed = variants.filter((v) => matchesOptions(v, product.fixedOptions));
  if (!product.customerOption) {
    const anyAvailable = fixed.some(isAvailable);
    return {
      rewardKey: product.rewardKey,
      productTitle: product.title,
      imageUrl,
      note: product.note,
      customerOption: null,
      choices: null,
      preselect: null,
      anyAvailable,
    };
  }
  const optionKey = key(product.customerOption);
  const byValue = new Map<string, { stock: number; available: boolean }>();
  for (const v of fixed) {
    const value = v.options[optionKey];
    if (value === undefined) continue;
    const entry = byValue.get(value) ?? { stock: 0, available: false };
    if (isAvailable(v)) {
      entry.stock += v.inventoryQuantity;
      entry.available = true;
    }
    byValue.set(value, entry);
  }
  const choices: GiftChoice[] = [...byValue.entries()]
    .map(([value, e]) => ({ value, available: e.available, stock: e.stock }))
    .sort((a, b) => compareChoice(a.value, b.value));
  const preselect =
    choices.filter((c) => c.available).sort((a, b) => b.stock - a.stock)[0]?.value ?? null;
  return {
    rewardKey: product.rewardKey,
    productTitle: product.title,
    imageUrl,
    note: product.note,
    customerOption: product.customerOption,
    choices,
    preselect,
    anyAvailable: preselect !== null,
  };
}

export type PickResult =
  | { ok: true; variant: VariantStock }
  | { ok: false; reason: "no_stock" | "invalid_selection" | "selection_required" };

/**
 * Resolves the variant to add: the fixed options, the customer's selection,
 * then the available variant with the most stock (ties: first in catalogue order).
 */
export function pickVariant(
  product: GiftProduct,
  variants: readonly VariantStock[],
  selection: Readonly<Record<string, string>> | null,
): PickResult {
  const wanted: Record<string, string> = { ...product.fixedOptions };
  if (product.customerOption) {
    const chosen = selection?.[product.customerOption] ?? selection?.[key(product.customerOption)];
    if (!chosen) return { ok: false, reason: "selection_required" };
    const known = variants.some(
      (v) =>
        (v.options[key(product.customerOption!)] ?? "").toLowerCase() ===
        chosen.trim().toLowerCase(),
    );
    if (!known) return { ok: false, reason: "invalid_selection" };
    wanted[product.customerOption] = chosen;
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
