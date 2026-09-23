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
- `extensions/` — checkout UI extension and theme app extension (later steps).

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

## Gifts

Gift slices are wired to a `GiftIssuer` interface. The real issuer will add the gift variant to
the order through the Order Editing API with a 100% line discount (`write_order_edits`). Until it
exists, gift outcomes return a retryable 503 and write nothing.
