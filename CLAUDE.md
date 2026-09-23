# CLAUDE.md

Context for the GreenTee Spin to Win app. Read this before writing code.

## What this app does

GreenTee Golf Shop runs a Wheel of Fortune promotion from October 1 to November 2, 2026.
A customer who places a qualifying online order is invited, on the Thank you page, to spin a
wheel once. The wheel awards either a discount code for a future purchase or a complimentary
GFJ gift (claimed manually).

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

The wheel shows 10 slices. Slice probabilities are what the app actually rolls; the visual
layout deliberately over-represents gifts. "Try Again" is decorative and must never be selected.

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
| 10    | Try Again                     | `try_again`     | 0%          |

Totals: discount codes 75%, gifts 25%, try again 0%. Slices 2 and 7 award the same reward, as do
4 and 8, and 5 and 9. The table must live in one config module and the code must assert that the
probabilities sum to exactly 100 at startup.

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
- Code format: `GT-` plus 8 characters from an unambiguous alphabet (no O, 0, I, 1).

### Gift rewards

Gifts do not create a discount. The app records the reward and returns claim instructions. Staff
fulfil these manually. Generate a short claim reference (`GFJ-` plus 6 characters) so staff can
match a customer to the recorded spin.

## Architecture

```
Thank you page (Checkout UI extension)
  -> POST {APP_URL}/api/spin/status   { orderId }
     returns { eligible, alreadySpun, reward, code, expiresAt, spinUrl }
  -> if eligible and not spun: Button links to spinUrl (signed token)

Spin page (storefront page + theme app extension block)
  -> GET  /apps/spin/state?token=...     verify token, return current state
  -> POST /apps/spin/execute             { token }  performs the spin
  -> renders the actual wheel in HTML and JS

Backend (Shopify app server)
  -> Admin GraphQL: order lookup, metafieldsSet, discountCodeBasicCreate
  -> Omnisend: contact upsert + custom event (best effort, never blocking)
```

### Why the wheel is not in the extension

See hard constraint 2. The extension establishes eligibility and hands off to a storefront page
through an App Proxy, carrying an HMAC signed token that contains the order ID and an expiry.
The spin page verifies the token server side; it never trusts an order ID from the query string.

### Required scopes

`read_orders`, `write_discounts`. Note that `read_orders` only covers orders from the last 60
days, which is sufficient here. Do not request `read_all_orders`; it needs Shopify approval.

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
  "code": "GT-7K2Q9MXA",
  "discountNodeId": "gid://shopify/DiscountCodeNode/123456789",
  "expiresAt": "2026-11-02T17:00:00.000Z",
  "email": "customer@example.com",
  "notified": true
}
```

For gifts, `rewardType` is `gift`, `code` holds the claim reference, and `discountNodeId` is null.

## Idempotency: the important part

There is no database and no compare and swap on metafields, so two concurrent requests could
both see an empty metafield. The fix is determinism plus a natural unique key.

1. **The outcome is derived, not rolled.** Compute
   `hmacSha256(SPIN_SECRET, String(orderId))`, take the first 8 hex characters as an integer,
   divide by 0xFFFFFFFF to get a value in `[0, 1)`, and map it onto the cumulative slice table.
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
- `OMNISEND_API_KEY`
- `APP_URL`

## Test mode

The app must be installable and fully exercisable on the live store before launch without any
real customer seeing the wheel. `CAMPAIGN_MODE` controls this.

- `off`: nobody sees anything. Both endpoints return `{ campaignOpen: false }`. This is also the
  mid campaign kill switch.
- `test`: only test users see the wheel. Everyone else gets the same response as `off`.
- `live`: normal operation. Test users still work, and their spins are still flagged as tests.

### Who counts as a test user

Evaluated server side during eligibility, in this order. Any match qualifies.

1. The order's customer has the tag in `TEST_TAG` (default `test-user`).
2. The order itself has that tag. This covers guest checkouts and lets staff flag a single order
   after the fact.
3. The order email is in `TEST_EMAILS`.

Tag matching is case insensitive and trims whitespace, because Shopify tags are entered by hand.

### What changes for a test user

- In `test` mode they are the only ones who pass eligibility.
- If `TEST_BYPASS_MIN_SUBTOTAL` is true, the 300 CAD minimum is skipped for them, so testers do
  not have to place expensive real orders. It never applies to anyone else.
- The stored metafield includes `"testMode": true`.
- Generated discount codes use the prefix `GT-TEST-` instead of `GT-`, and the discount title is
  prefixed `Spin TEST` so they are trivial to filter and bulk delete afterwards.
- Omnisend calls are skipped entirely unless `OMNISEND_TEST_SENDS` is true, so test spins never
  touch the real contact list or fire real automations.

### Forcing an outcome

Outcomes are derived deterministically from the order ID, which makes testing a specific reward
awkward. For test users only, accept an optional `forceSlice` parameter (1 to 10) on the execute
endpoint and use it instead of the derived slice. Reject it with a 403 for anyone who is not a
test user, and record `"forced": true` in the metafield when it is used. Slice 10 must stay
unreachable even here.

### Cleanup

Provide a script that lists every discount whose title starts with `Spin TEST` and deletes them,
and that clears the spin metafield from tagged test orders. Run it before launch. Never let it
touch anything without the test prefix.

## Omnisend integration

After a successful spin, fire and forget:

1. Upsert the contact with custom properties `spin_reward`, `spin_code`, `spin_expires`.
2. Send a custom event `spin_won` to trigger the reward email.

Rules:

- Never block the spin response on Omnisend. Queue it or run it after responding.
- A failure here is logged, not surfaced to the customer. The code is already on screen.
- Only mark the contact as a marketing subscriber if the customer opted in. Reward delivery is
  not marketing consent, and Canadian anti spam rules make this distinction matter.

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
  the assertion that slice 10 is unreachable.

## Out of scope

Do not build these unless asked:

- The `customer-account.order-status.block.render` target. The extension renders on the thank you
  page only. This is a deliberate decision, not an oversight: the spin happens immediately after
  checkout, which keeps the order unfulfilled and keeps the gift flow simple.
- Any pre purchase or landing page wheel. The approved flow is post purchase only.
- In store and POS participation. Staff handle that manually outside this app.
- A no purchase alternative entry route. That is handled through the Official Rules, offline.
- An admin dashboard. Reporting is done by exporting order metafields at the end of the campaign.