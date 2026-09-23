/**
 * Gift issuance boundary.
 *
 * Decision (Sept 2026): gifts are not claim references. When a gift slice is
 * won, the real product variant is added to the order through the Order
 * Editing API with a 100% line discount, so the customer pays nothing and the
 * order shows the gift explicitly. That needs the `write_order_edits` scope
 * and a variant selection rule for sized items, which is still undecided.
 *
 * Until then the only issuer refuses loudly. The spin path treats that as a
 * retryable failure and never writes the metafield, so nothing is thrown away
 * and no order is half-recorded.
 *
 * TODO(gifts): implement `orderEditGiftIssuer`:
 *   1. Re-read the order and look for a line item whose custom attribute
 *      `_spin_gift` equals `input.giftReference`. If present, return it
 *      (idempotent replay after a crash between commit and metafield write).
 *   2. orderEditBegin(id) -> orderEditAddVariant(variantId, quantity 1,
 *      customAttributes [{ key: "_spin_gift", value: giftReference }])
 *      -> orderEditAddLineItemDiscount(percentValue 100)
 *      -> orderEditCommit(notifyCustomer: false, staffNote).
 *   3. Return { variantId, lineItemId, orderEditId, reference }.
 *   Variant lookup per rewardKey (gloves/brush/socks, plus size rule) belongs
 *   in config, not here.
 */
import type { Slice } from "~/config/campaign";
import type { GiftIssuance } from "~/lib/spin-result";
import type { AdminClient } from "~/lib/admin.server";

export interface GiftIssueInput {
  readonly admin: AdminClient;
  readonly orderId: string;
  readonly orderGid: string;
  readonly slice: Slice;
  /** Derived, stable per order. Use as the idempotency handle. */
  readonly giftReference: string;
  readonly testMode: boolean;
}

export interface GiftIssuer {
  issue(input: GiftIssueInput): Promise<GiftIssuance>;
}

export class GiftIssuanceUnavailableError extends Error {
  readonly retryable = true;
  constructor(message = "Gift issuance is not implemented yet") {
    super(message);
    this.name = "GiftIssuanceUnavailableError";
  }
}

export const unimplementedGiftIssuer: GiftIssuer = {
  async issue(input) {
    throw new GiftIssuanceUnavailableError(
      `Gift issuance for ${input.slice.rewardKey} is not implemented (order ${input.orderId})`,
    );
  },
};
