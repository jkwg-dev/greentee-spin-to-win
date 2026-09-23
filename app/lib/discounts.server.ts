/**
 * Discount code creation with the duplicate-as-success rule from CLAUDE.md.
 */
import type { AdminClient, UserError } from "~/lib/admin.server";
import { collectUserErrors } from "~/lib/admin.server";
import { log } from "~/lib/log.server";

export const DISCOUNT_CREATE_MUTATION = /* GraphQL */ `
  mutation SpinDiscountCreate($basicCodeDiscount: DiscountCodeBasicInput!) {
    discountCodeBasicCreate(basicCodeDiscount: $basicCodeDiscount) {
      codeDiscountNode {
        id
        codeDiscount {
          ... on DiscountCodeBasic {
            title
            endsAt
          }
        }
      }
      userErrors {
        field
        code
        message
      }
    }
  }
`;

export const DISCOUNT_BY_CODE_QUERY = /* GraphQL */ `
  query SpinDiscountByCode($code: String!) {
    codeDiscountNodeByCode(code: $code) {
      id
      codeDiscount {
        ... on DiscountCodeBasic {
          title
          status
          endsAt
        }
      }
    }
  }
`;

export interface EnsureDiscountInput {
  readonly orderId: string;
  readonly code: string;
  readonly title: string;
  /** Whole percent, e.g. 15. */
  readonly percentage: number;
  readonly collectionId: string;
  readonly startsAt: Date;
  readonly endsAt: Date;
}

export interface EnsuredDiscount {
  readonly discountNodeId: string;
  readonly code: string;
  readonly created: boolean;
}

export class DiscountCreateError extends Error {
  readonly retryable: boolean;
  readonly details: unknown;
  constructor(message: string, opts: { retryable: boolean; details?: unknown }) {
    super(message);
    this.name = "DiscountCreateError";
    this.retryable = opts.retryable;
    this.details = opts.details;
  }
}

/** Shopify reports an existing code as TAKEN on the `code` field. */
export function isDuplicateCodeError(errors: readonly UserError[]): boolean {
  return errors.some((e) => {
    const onCode = (e.field ?? []).some((f) => String(f).toLowerCase() === "code");
    const code = (e.code ?? "").toUpperCase();
    return (
      (onCode && (code === "TAKEN" || code === "DUPLICATE")) ||
      /already (been )?taken|already exists|must be unique/i.test(e.message)
    );
  });
}

export function buildDiscountInput(input: EnsureDiscountInput): Record<string, unknown> {
  return {
    title: input.title,
    code: input.code,
    startsAt: input.startsAt.toISOString(),
    endsAt: input.endsAt.toISOString(),
    usageLimit: 1,
    appliesOncePerCustomer: true,
    customerSelection: { all: true },
    customerGets: {
      value: { percentage: input.percentage / 100 },
      items: { collections: { add: [input.collectionId] } },
    },
    combinesWith: { productDiscounts: false, orderDiscounts: false, shippingDiscounts: false },
    // Deliberately no minimumRequirement: the order that earned the spin already met the gate.
  };
}

interface CreateData {
  discountCodeBasicCreate: {
    codeDiscountNode: { id: string; codeDiscount: { title?: string; endsAt?: string } } | null;
    userErrors: UserError[];
  };
}

interface LookupData {
  codeDiscountNodeByCode: {
    id: string;
    codeDiscount: { title?: string; status?: string; endsAt?: string };
  } | null;
}

/**
 * Creates the single-use code, or, if it already exists (a racing request or
 * an earlier crash after creation), looks it up and returns it. The existing
 * discount must carry the expected title; otherwise something else owns that
 * code and we refuse rather than hand out a mismatched reward.
 */
export async function ensureDiscount(
  admin: AdminClient,
  input: EnsureDiscountInput,
): Promise<EnsuredDiscount> {
  const l = log.child({ orderId: input.orderId, code: input.code });
  const data = await admin.request<CreateData>(
    DISCOUNT_CREATE_MUTATION,
    { basicCodeDiscount: buildDiscountInput(input) },
    { operation: "discountCodeBasicCreate", orderId: input.orderId },
  );
  const payload = data.discountCodeBasicCreate;
  const errors = payload?.userErrors ?? collectUserErrors(data);

  if (errors.length === 0 && payload?.codeDiscountNode?.id) {
    l.info("discount.created", { discountNodeId: payload.codeDiscountNode.id, title: input.title });
    return { discountNodeId: payload.codeDiscountNode.id, code: input.code, created: true };
  }

  if (isDuplicateCodeError(errors)) {
    l.info("discount.duplicate.lookup", { userErrors: errors });
    const found = await admin.request<LookupData>(
      DISCOUNT_BY_CODE_QUERY,
      { code: input.code },
      { operation: "codeDiscountNodeByCode", orderId: input.orderId },
    );
    const node = found.codeDiscountNodeByCode;
    if (!node) {
      throw new DiscountCreateError("Code reported as taken but lookup found nothing", {
        retryable: true,
        details: errors,
      });
    }
    if (node.codeDiscount?.title !== input.title) {
      l.error("discount.duplicate.title_mismatch", {
        expected: input.title,
        actual: node.codeDiscount?.title,
      });
      throw new DiscountCreateError("Existing discount does not match the expected reward", {
        retryable: false,
        details: { expected: input.title, actual: node.codeDiscount?.title, id: node.id },
      });
    }
    l.info("discount.duplicate.reused", { discountNodeId: node.id });
    return { discountNodeId: node.id, code: input.code, created: false };
  }

  // Anything else: log the full payload and surface a retryable error. The
  // caller must not write the metafield.
  l.error("discount.create.failed", { userErrors: errors, payload });
  throw new DiscountCreateError("discountCodeBasicCreate returned userErrors", {
    retryable: true,
    details: errors,
  });
}
