# Spin to Win: operations note for staff

Campaign: October 1 to November 2, 2026, 9:00 AM Pacific. One spin per qualifying online
order (300 CAD subtotal or more), taken on the Thank you page right after checkout.

## What a customer gets

- **Discount code** (75% of spins): a single-use eight-character code such as `7K2Q9MXA` (no
  prefix; letters and digits only, never O, 0, I or 1) for 10% off clubs, 15% off
  accessories or 30% off apparel, regular priced collections only. It expires with the campaign.
  The code is shown on screen and on the customer's order status page. We do not email it.
- **Gift** (25% of spins): GFJ Aura Control gloves (customer picks hand and size; white only),
  GFJ socks or a GFJ club brush (we pick the colour). The gift is added to the same order as a
  new line at 100% off, so it ships with the order. Nothing is shipped separately.

## The two gift tags

| Tag            | Meaning                                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gift-pending` | The customer won a gift but it has **not** been added to the order. Either they closed the page before confirming, or the gift was out of stock when they tried. |
| `gift-added`   | The gift line is on the order at $0. Nothing to do. Pick, pack and ship as normal.                                                                               |

An order never carries both. `gift-pending` is set the moment the wheel lands on a gift;
it flips to `gift-added` only after the line is on the order.

## Finding them

In Shopify admin, Orders, use the search box:

- `tag:gift-pending` — needs attention.
- `tag:gift-added` — informational.

The order also carries a metafield **Spin to Win result** (Additional details on the order page).
Its `gift.status` is `pending`, `added` or `unavailable`, and `gift.reason` says why an add
failed (for example `no_stock for {"Size":"22"}`).

## What to do about a `gift-pending` order

1. Check `gift.status` in the metafield.
   - `pending`: the customer never confirmed. They can still finish from their Thank you page
     link while the campaign runs. If the order is about to ship, reach out and ask for their
     glove hand and size (socks and brush need nothing), then add the item by hand.
   - `unavailable`: the size or product was out of stock when they confirmed. Offer the same
     item in another size (or colour, for socks and brush) if stock allows, or agree an alternative with the customer.
     Do not swap to a different product without asking.
2. Add the gift by editing the order: add the variant, apply a 100% discount to that line,
   uncheck "send notification" if you prefer, and save.
3. Remove `gift-pending` and add `gift-added` so it drops out of the search.
4. Add a short order note saying what was done.

Never delete the Spin to Win metafield. It is the record of what the customer won.

## Discount codes

In Discounts, every spin discount is titled `2026 Oct Spin Wheel of Fortune Promotion - <reward>`,
for example `2026 Oct Spin Wheel of Fortune Promotion - 10% Clubs`, one per winning order. To
list them, search Discounts for `2026 Oct Spin Wheel`. To find a customer's discount from their
code, search Discounts for the code itself.

Test discounts are titled `2026 Oct Spin Wheel of Fortune Promotion TEST - <reward>` and their
codes start with `TEST-`. Search `Promotion TEST` to see only those. They are deleted before
launch and must not be honoured after October 1.

## If the wheel needs to be switched off

Shop settings, Custom data, Shop: set **Spin to Win campaign mode** to `off`. It takes effect
within a minute and hides everything: the wheel, the Thank you page banner and the stored codes
on order status pages. Codes already issued still work at checkout until they expire. Set it back
to `live` to resume. No developer needed.
