# GreenTee Spin to Win

Standalone Shopify app for the October 1 to November 2, 2026 Wheel of Fortune promotion.
Read `CLAUDE.md` first: it holds the business rules, hard constraints and data model.

## Layout

- `app/config/campaign.ts` — reward table, campaign window, code formats, metafield definition.
- `app/config/env.server.ts` — validated environment (`CAMPAIGN_MODE`, thresholds, test mode).
- `app/lib/outcome.ts` — deterministic HMAC outcome and code derivation.
- `app/lib/eligibility.ts` — pure eligibility rules, including test users.
- `app/lib/spin.server.ts` — the spin use cases (status, state, execute) with the idempotency path.
- `app/lib/admin.server.ts` — Admin GraphQL wrapper; client credentials grant, throttle aware, logs
  operation, order ID and `userErrors` on every call.
- `app/lib/gifts.server.ts` — gift issuance boundary (Order Editing API, not yet implemented).
- `app/routes/api.spin.status.tsx` — `POST /api/spin/status`, session token protected, CORS.
- `app/routes/apps.spin.state.tsx`, `apps.spin.execute.tsx` — app proxy endpoints.
- `scripts/setup-metafields.ts` — one-time metafield definitions.
- `scripts/cleanup-test-data.ts` — deletes `Spin TEST` discounts and test spin records.
- `extensions/spin-status/` — checkout UI extension (Preact + Polaris web components, API 2026-07).
  `src/ThankYou.tsx` is the full flow on `purchase.thank-you.block.render`;
  `src/OrderStatus.tsx` is display only on `customer-account.order-status.block.render`.
- Theme app extension holding the wheel: step 4.

## Setup

```sh
pnpm install
cp .env.example .env      # fill in values
pnpm test                 # unit tests
pnpm typecheck
shopify app config link   # once, to bind to the Dev Dashboard app
pnpm dev                  # shopify app dev
```

## Authentication

The app serves one store and uses the client credentials grant: it exchanges its client ID and
secret for a 24 hour Admin API token, cached in memory. No OAuth redirect, no session storage.
This requires the store and the app to be in the same Dev Dashboard organisation.

Requests are authenticated per surface:

- Thank you page extension -> `POST /api/spin/status` with the extension session token as a
  Bearer JWT, verified against the app secret.
- Spin page -> `/apps/spin/*` through the Shopify app proxy. The proxy signature is verified,
  then the HMAC signed `token` (order ID + expiry) that the Thank you page put in the URL.

## Campaign mode

`CAMPAIGN_MODE` is `off` (kill switch, default), `test` (only test users see the wheel) or
`live`. The shop metafield `greentee_spin.campaign_mode` (created by `pnpm setup:metafields`)
overrides the environment when set, so staff can flip it from Settings > Custom data > Shop
without a deploy. It is re-read every 30 seconds. `GET /` reports the current mode.

## Test mode

Test users are orders whose customer or order carries the `test-user` tag (case insensitive),
or whose email is in `TEST_EMAILS`. Their spins are flagged `testMode`, use `GT-TEST-` codes
and `Spin TEST` discount titles, and may pass `forceSlice` (1 to 9) to the execute endpoint.
Testers bypass the campaign window so the flow can be exercised before October 1, and bypass
the 300 CAD minimum only when `TEST_BYPASS_MIN_SUBTOTAL=true`.

```sh
pnpm cleanup:test-data            # dry run
pnpm cleanup:test-data -- --apply # delete Spin TEST discounts, clear test spin records
```

## Checkout UI extension

Both targets call `POST /api/spin/status` with the extension session token and share one
result card, so the two pages can never disagree about a reward. The extension reads the app
server URL from its `app_url` setting: set it in the checkout editor (Thank you page) and in the
customer accounts editor (Order status page) after the first deploy. Network access must be
allowed once in the Dev Dashboard under API access.

The Thank you page shows three states: not eligible (encouraging banner), eligible (button
linking to the signed spin URL), already spun (code or gift with expiry and a copy control).
While the order is still being created it shows a "just a moment" banner and polls for about
20 seconds. The Order status page renders the stored reward or nothing at all. A spin can only
start from the Thank you page.

## Gifts

Gift slices are wired to a `GiftIssuer` interface. The real issuer will add the gift variant to
the order through the Order Editing API with a 100% line discount (`write_order_edits`). Until it
exists, gift outcomes return a retryable 503 and write nothing.
