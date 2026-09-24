# CLAUDE.md

Context for the GreenTee Spin to Win app. Read this before writing code.

## What this app does

GreenTee Golf Shop runs a Wheel of Fortune promotion from October 1 to November 2, 2026.
A customer who places a qualifying online order is invited, on the Thank you page, to spin a
wheel once. The wheel awards either a discount code for a future purchase or a complimentary
GFJ gift added to the same order at no charge (see Gift rewards).

This is a standalone custom Shopify app built only for this campaign. It is deliberately
separate from GreenTee's other apps so it can be removed cleanly when the campaign ends.

## Hard constraints

These are not negotiable. Design around them.

1. **The store is on Shopify Advanced, not Plus.** Custom apps on non-Plus stores cannot use
   Shopify Functions. Do not propose or scaffold a discount function. All discounts must be
   standard Shopify discounts created through the Admin GraphQL API.
2. **Checkout UI extensions cannot render a custom wheel.** They render Shopify's own remote UI
   components. There is no canvas, no arbitrary HTML, no custom CSS. The thank you page
   extension therefore only shows an eligibility banner, a spin button that links out, and the
   result once a spin exists. The wheel itself lives on a storefront page (see Architecture).
3. **No external database.** All state is stored in Shopify order metafields. There is no
   Postgres, no Redis, no Prisma models for spin data. Session storage for OAuth may use
   whatever the Shopify app template provides.
4. **One spin per order, enforced server side.** Client state is a convenience only and is never
   trusted.
5. **Eligibility is computed from the order, never from the client.** The client may send an
   order ID; the server fetches the order and decides.

## Business rules

### Eligibility

- The order's subtotal must be at least 300.00 CAD.
- Subtotal means `currentSubtotalPriceSet` from the Admin API: after discounts, excluding taxes
  and shipping. Do not attempt to filter sale items; the approved rule uses the full subtotal.
- The threshold is configuration, not a literal, so it can be changed without a deploy.

### Rewards and probabilities

The wheel shows 9 slices. Slice probabilities are what the app actually rolls; the visual
layout deliberately over-represents gifts. Every slice awards something; there is no "try again"
slice (one was removed on purpose, so do not add a decorative slice back).

Slices are coloured by what they award, not by position: discount slices are cream, gift slices
alternate navy and green so two gift slices never touch in the same colour, and label text
follows the background (navy on cream, cream on navy or green). Each slice carries a small
"Discount" or "Free gift" chip, and the same chip appears on the result card.

Because the layout over-represents gifts, the spin page discloses the real odds under the wheel
(75% discount code, 25% gift) with a note that section size and placement do not represent the
actual chances. Both numbers come from `rewardOdds()` in `app/config/campaign.ts`, derived from
the table, and a test asserts the displayed split matches it. A block setting holds the
promotion rules URL; the link renders only when it is set.

| Slice | Reward displayed              | Reward key      | Probability |
|-------|-------------------------------|-----------------|-------------|
| 1     | 10% Off Eligible Clubs        | `clubs_10`      | 25%         |
| 2     | GFJ Gloves                    | `gift_gloves`   | 4%          |
| 3     | 15% Off Eligible Accessories  | `accessories_15`| 25%         |
| 4     | GFJ Club Brush                | `gift_brush`    | 4%          |
| 5     | GFJ Socks                     | `gift_socks`    | 4%          |
| 6     | 30% Off Eligible Apparel      | `apparel_30`    | 25%         |
| 7     | GFJ Gloves                    | `gift_gloves`   | 4%          |
| 8     | GFJ Club Brush                | `gift_brush`    | 4%          |
| 9     | GFJ Socks                     | `gift_socks`    | 5%          |

Totals: discount codes 75%, gifts 25%. Slices 2 and 7 award the same reward, as do 4 and 8, and
5 and 9. The table must live in one config module and the code must assert that the
probabilities sum to exactly 100 at startup and that every slice has a positive probability.

### Discount rewards

Each discount reward creates one single use code through `discountCodeBasicCreate`:

- Percentage value per the table above.
- `customerGets.items.collections` set to the matching regular priced collection ID
  (clubs, accessories, or apparel). Collection IDs come from config.
- **No minimum purchase requirement.** The 300 CAD gate was already satisfied by the order that
  earned the spin. Adding a minimum here would double charge the customer for the same condition.
- `usageLimit: 1`, `appliesOncePerCustomer: true`.
- `combinesWith`: product, order, and shipping discounts all false.
- `endsAt` is the campaign end (November 2, 2026, 09:00 America/Vancouver). All codes expire
  together when the campaign closes.
- Code format: 8 characters from an unambiguous alphabet (no O, 0, I, 1), no prefix, e.g.
  `7K2Q9MXA`. Customers type these on a phone and staff read them aloud. Test codes alone carry a
  prefix: `TEST-7K2Q9MXA`.
- Discount title: `CAMPAIGN_TITLE` from `campaign.ts` ("2026 Oct Spin Wheel of Fortune
  Promotion") with the reward appended, e.g. `2026 Oct Spin Wheel of Fortune Promotion - 10%
  Clubs`. Test discounts insert `TEST` after the campaign name: `... Promotion TEST - 10% Clubs`.

### Gift rewards

Gifts do not create a discount and are not a claim reference. When a gift slice is won, the app
adds the real product variant to the order through the Order Editing API with a 100 percent line
discount, so the customer pays nothing and the order shows the gift explicitly. This needs the
`write_order_edits` scope (and `read_products` for variants and stock).

All product and variant identity lives in `GIFT_CATALOG` in `app/config/campaign.ts` and nowhere
else. The socks product is provisional and may change.

| Reward        | Product                                   | Options                                   | Customer chooses |
|---------------|-------------------------------------------|-------------------------------------------|------------------|
| `gift_gloves` | GFJ Classic Glove (Unisex), 24 variants   | Hand (always LH), Color, Size 18 to 25     | Size             |
| `gift_socks`  | GFJ Jacquard Ankle High Socks, 3 variants | Colour: Black, Beige, Navy                 | nothing          |
| `gift_brush`  | GFJ x GreenTee Club Cleaning Brush, 4     | Colour: White, Black, Green, Orange        | nothing          |

The app picks the colour with the most stock (in the chosen size for gloves). Hand is fixed at LH
and never shown as a choice. Customer copy for the glove must say it is left hand (LH) and that
the colour is randomly selected.

#### Flow

1. On a gift result, `executeSpin` writes the spin metafield with `gift.status = "pending"` and
   tags the order `gift-pending` before anything else. Nothing is added to the order yet.
2. The spin page shows the gift step. Glove only: a size selector with an in-stock size
   preselected (the one with most stock) and sold-out sizes disabled. Socks and brush: just the
   confirm button.
3. `POST /apps/spin/gift` (`confirmGift`) resolves the variant, then `orderEditBegin`,
   `orderEditAddVariant`, `orderEditAddLineItemDiscount` (100%), `orderEditCommit` with
   `notifyCustomer: false` and a staff note carrying the `GFJ-` reference.
4. It records `variantId`, `variantTitle`, `lineItemId`, `orderEditId` and the selection in the
   metafield with `gift.status = "added"`, then adds `gift-added` and removes `gift-pending`.

The Thank you page keeps its spin link while a gift is pending so the customer can come back and
finish. The order status page shows the pending state as text only.

#### Stock rules

- A variant counts only when `inventoryQuantity > 0` and `availableForSale` is true. Negative
  inventory (oversells) is excluded.
- If every variant of the won gift is unavailable, do not edit the order. Show a message asking
  the customer to contact us, leave the tag at `gift-pending`, and record the reason in the
  metafield (`gift.status = "unavailable"`). A later confirm may succeed if stock returns.
- Never substitute a different gift product or size. Staff handle those cases manually.

#### Idempotency

`confirmGift` returns an added gift as is. Before editing, it looks for a line of the gift
product that is already fully discounted (a crash between commit and the metafield write) and
adopts it rather than adding another. An order edit that fails leaves the record pending and the
tag in place, so a retry is safe.

#### Why gift-pending matters

The customer may close the page before confirming, especially on the glove step. Staff use the
tag to find anyone who dropped off, so it is written before the order edit and only flipped to
`gift-added` after the edit commits.

The spin always happens on the Thank you page moments after checkout, so the order is always
unfulfilled at spin time. Do not build a fulfilled-order fallback path.

## Architecture

```
Thank you page (Checkout UI extension, purchase.thank-you.block.render)
  -> POST {APP_URL}/api/spin/status   { orderId }   (Bearer: extension session token)
     orderId arrives in three shapes and is normalised to the numeric ID:
       gid://shopify/OrderIdentity/<id>  thank you target (its typings say
                                         Order/<id>; that is wrong)
       gid://shopify/Order/<id>          order status target
       <id>                              scripts and tests
     The outcome HMAC runs on the normalised ID, so the shape can never
     change the reward. Anything else is a 400 naming what it received.
     returns { campaignOpen, eligible, alreadySpun, result, spinUrl }
  -> if eligible and not spun: Button links to spinUrl (signed token)

Order status page (same extension, customer-account.order-status.block.render)
  -> same status call; renders the stored result only, or nothing at all

Spin page (storefront page + theme app extension block)
  -> GET  /apps/spin/state?token=...     verify token, return current state (+ gift offer)
  -> POST /apps/spin/execute             { token }  performs the spin
  -> POST /apps/spin/gift                { token, selection? }  adds a won gift to the order
  -> renders the actual wheel in HTML and JS

Backend (Shopify app server)
  -> Admin GraphQL: order lookup, metafieldsSet, discountCodeBasicCreate,
     product variants + stock, orderEdit*, tagsAdd/tagsRemove
```

### Why the wheel is not in the extension

See hard constraint 2. The extension establishes eligibility and hands off to a storefront page
through an App Proxy, carrying an HMAC signed token that contains the order ID and an expiry.
The spin page verifies the token server side; it never trusts an order ID from the query string.

### Required scopes

Each scope is tied to a specific operation. Do not add one without adding its row here.

| Scope               | Needed by                                                                 |
|---------------------|---------------------------------------------------------------------------|
| `write_orders`      | `metafieldsSet` on an Order (the spin record) and `tagsAdd` / `tagsRemove` on an Order (`gift-pending`, `gift-added`). Write includes read, so it also covers the `order` lookup. |
| `write_discounts`   | `discountCodeBasicCreate`; includes read for `codeDiscountNodeByCode` on a duplicate. |
| `write_order_edits` | `orderEditBegin`, `orderEditAddVariant`, `orderEditAddLineItemDiscount`, `orderEditCommit`. Order editing has its own scope; `write_orders` does not grant it. |
| `read_customers`    | **Not requested.** Nothing may read `order.customer`; test users come from the order's own tags and email. |
| `read_products`     | `product` with `variants` (`availableForSale`, `inventoryQuantity`, `selectedOptions`, `featuredImage`) for gift stock and the size list. Read only; nothing writes products. |

Order access only covers orders from the last 60 days, which is sufficient here. Do not request
`read_all_orders`; it needs Shopify approval. `pnpm check:scopes` compares the granted scopes
with `shopify.app.toml`.

## Data model

One metafield on the order. Definition is store owned (not app owned) so records survive app
uninstall.

- namespace: `greentee_spin`
- key: `result`
- type: `json`
- ownerType: `ORDER`

Value shape:

```json
{
  "version": 1,
  "spunAt": "2026-10-03T18:22:41.000Z",
  "sliceIndex": 3,
  "rewardKey": "accessories_15",
  "rewardLabel": "15% Off Eligible Accessories",
  "rewardType": "discount",
  "code": "7K2Q9MXA",
  "discountNodeId": "gid://shopify/DiscountCodeNode/123456789",
  "expiresAt": "2026-11-02T17:00:00.000Z",
  "email": "customer@example.com",
  "gift": null,
  "testMode": false,
  "forced": false
}
```

There is no `notified` field: the code is delivered on screen and nowhere else. The record also
carries `testMode` and `forced` (see Test mode). For gifts, `rewardType` is `gift`, `code` and
`discountNodeId` are null, and `gift` holds `{ status: "pending" | "added" | "unavailable",
productId, variantId, variantTitle, lineItemId, orderEditId, reference, selection, reason,
updatedAt }`.

## Idempotency: the important part

There is no database and no compare and swap on metafields, so two concurrent requests could
both see an empty metafield. The fix is determinism plus a natural unique key.

1. **The outcome is derived, not rolled.** Compute
   `hmacSha256(SPIN_SECRET, normalizeOrderId(orderId))`, take the first 8 hex characters as an
   integer,
   divide by 2^32 (0x100000000, so the range is the half-open `[0, 1)`; dividing by 0xFFFFFFFF
   would allow exactly 1.0), and map it onto the cumulative slice table. The order ID is
   normalised to its numeric form first so a GID and a bare ID derive the same outcome.
   The same order always produces the same slice. Two racing requests cannot disagree.
2. **The code is derived too.** Derive the code suffix from the same HMAC, so both requests would
   try to create the identical code. Shopify rejects a duplicate code, so at most one discount is
   ever created. On a duplicate code error, look the code up and continue as a success.
3. **Write the metafield last**, after the discount exists. `metafieldsSet` is an upsert, so a
   second writer simply writes identical content.

Never make the outcome depend on request time, random seeds, or anything else that differs
between two concurrent calls.

## Configuration

Everything below is config, read at runtime. Use environment variables, and prefer a shop
metafield for values that a non developer may need to change mid campaign.

- `CAMPAIGN_MODE`: `off`, `test`, or `live`. See Test mode below. `off` is the kill switch: the
  extension shows nothing and the spin endpoints return a friendly closed state.
- `CAMPAIGN_START`, `CAMPAIGN_END` (ISO, America/Vancouver)
- `TEST_TAG` (default `test-user`)
- `TEST_EMAILS` (comma separated allowlist, for guest checkouts)
- `TEST_BYPASS_MIN_SUBTOTAL` (boolean, default false)
- `MIN_SUBTOTAL_CAD` (default 300)
- `COLLECTION_CLUBS`, `COLLECTION_ACCESSORIES`, `COLLECTION_APPAREL` (regular priced collection GIDs)
- `SPIN_SECRET` (HMAC key for outcome derivation and token signing)
- `APP_URL`

## Test mode

The app must be installable and fully exercisable on the live store before launch without any
real customer seeing the wheel. `CAMPAIGN_MODE` controls this.

- `off`: nobody sees anything. Both endpoints return `{ campaignOpen: false }`. This is also the
  mid campaign kill switch.
- `test`: only test users see the wheel. Everyone else gets the same response as `off`.
- `live`: normal operation. Test users still work, and their spins are still flagged as tests.

### Who counts as a test user

Evaluated server side during eligibility, from the order alone. Either match qualifies.

1. The order itself carries the tag in `TEST_TAG` (default `test-user`). This covers guest
   checkouts and lets staff flag a single order after the fact.
2. The order email is in `TEST_EMAILS`.

Tag matching is case insensitive and trims whitespace, because Shopify tags are entered by hand.

**Customer tags are deliberately not consulted.** Reading `order.customer` requires the
`read_customers` scope, which this app does not request, and asking for it returns
`Access denied for customer field`. Tag the order, not the customer. `order.email` is protected
customer data: if that approval is missing the field is null and only the order tag works, so
the order tag is the reliable route.

### What changes for a test user

- In `test` mode they are the only ones who pass eligibility.
- They bypass the campaign start date, so the flow can be exercised before October 1. They do
  not bypass the end date: after November 2 the campaign is closed for everyone, so a stale test
  link can never mint a code once the promotion has ended.
- If `TEST_BYPASS_MIN_SUBTOTAL` is true, the 300 CAD minimum is skipped for them, so testers do
  not have to place expensive real orders. It never applies to anyone else.
- The stored metafield includes `"testMode": true`.
- Generated discount codes carry the prefix `TEST-` (live codes have none), and the discount
  title carries `TEST` after the campaign name, so they are trivial to filter and bulk delete.

### Forcing an outcome

Outcomes are derived deterministically from the order ID, which makes testing a specific reward
awkward. For test users only, accept an optional `forceSlice` parameter (1 to 9) on the execute
endpoint and use it instead of the derived slice. Reject it with a 403 for anyone who is not a
test user, and record `"forced": true` in the metafield when it is used.

### Cleanup

Provide a script that lists every discount whose title carries the `TEST` marker and whose code
starts with `TEST-` (both guards required) and deletes them,
and that clears the spin metafield from tagged test orders. Run it before launch. Never let it
touch anything without the test prefix.

## No email, ever

The discount code is delivered on screen and nowhere else. There is no transactional email
service, no send queue, and no "we emailed you a copy" copy anywhere in the UI. A customer who
closes the Thank you page gets back to their code through the read-only order status block.

## Omnisend: dropped deliberately

There is no Omnisend integration and none is planned. With no email in the flow there is no
automation for a `spin_won` event to trigger, so the integration would have added an API key,
consent handling and retry logic for no customer-visible benefit. This is a decision, not
unfinished work. Do not add it back without a new requirement.

## Error handling and edge cases

- The Thank you page can load before the order is queryable. Retry the order lookup a few times
  with backoff, and show a "just a moment" state rather than an error.
- If `discountCodeBasicCreate` returns `userErrors`, do not silently swallow it. Log the full
  payload, return a retryable error, and never write the metafield.
- If a customer reopens the thank you page after the campaign ends, still show their stored
  code with a clear "expired" indication.
- Rate limits: the Admin API is throttled. Cache eligibility lookups briefly per order and
  respect cost based throttling in the GraphQL response.
- Ineligible orders get an encouraging message, not an error.

## Code style and conventions

- TypeScript throughout.
- The reward table, campaign dates, and thresholds live in `app/config/campaign.ts` and are
  imported everywhere. No duplicated literals.
- Every Admin API call goes through a thin wrapper that logs the operation name, the order ID,
  and any `userErrors`.
- Structured logs keyed by order ID. Support questions are answered by grepping one order ID.
- Unit test the outcome mapping against the probability table, including the boundary values and
  the assertion that the largest possible roll still lands inside the table.

## Out of scope

Do not build these unless asked:

- Anything interactive on the `customer-account.order-status.block.render` target. That target
  is display only: if a stored spin result exists it shows the code or gift with its expiry and
  a copy control, otherwise it renders nothing. No eligibility banner, no spin button, no link to
  the spin page, no "you missed it" message. A spin can only ever start from the Thank you page,
  moments after checkout. That is an invariant.
- Any pre purchase or landing page wheel. The approved flow is post purchase only.
- In store and POS participation. Staff handle that manually outside this app.
- A no purchase alternative entry route. That is handled through the Official Rules, offline.
- An admin dashboard. Reporting is done by exporting order metafields at the end of the campaign.