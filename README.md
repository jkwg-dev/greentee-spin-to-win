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
- `app/lib/gifts.server.ts` — gift stock rules and issuance through the Order Editing API.
- `app/lib/host.ts` — host normalisation shared by the session token check and `SHOP_ALT_DOMAINS`.
- `app/routes/api.spin.status.tsx` — `POST /api/spin/status`, session token protected, CORS.
- `app/routes/apps.spin.state.tsx`, `apps.spin.execute.tsx`, `apps.spin.gift.tsx` — app proxy
  endpoints (state, spin, gift confirmation).
- `scripts/setup-metafields.ts` — one-time metafield definitions.
- `scripts/cleanup-test-data.ts` — deletes `TEST` discounts (title marker and `TEST-` code) and test spin records.
- `extensions/spin-status/` — checkout UI extension (Preact + Polaris web components, API 2026-07).
  `src/ThankYou.tsx` is the full flow on `purchase.thank-you.block.render`;
  `src/OrderStatus.tsx` is display only on `customer-account.order-status.block.render`.
- `extensions/spin-wheel/` — theme app extension: the wheel as a full-screen overlay block.
  `blocks/spin-wheel.liquid` (markup + settings), `assets/spin-page.js` (states, spin, result),
  `assets/spin-page.css`, and `assets/spin-wheel.js` (vendored `spin-wheel@5.0.2`, MIT, pinned).

## Setup

```sh
pnpm install
cp .env.example .env      # fill in values
pnpm test                 # unit tests
pnpm typecheck
shopify app config link   # once, to bind to the Dev Dashboard app
pnpm dev                  # shopify app dev
```

## Deploying to Vercel

The framework preset must be **React Router**. `vercel.json` pins it. The
`@vercel/react-router` preset in `react-router.config.ts` does not produce the deployable
output by itself: it emits server bundles plus `.vercel/react-router-build-result.json`, which
Vercel's React Router builder reads to create the function. With the framework unset or `null`,
that builder never runs, the build still succeeds, and every route returns 404.

`regions` in `vercel.json` sets where functions run, not where the build runs. See
`docs/LAUNCH-CHECKLIST.md` for the full settings table.

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

Test users are orders that themselves carry the `test-user` tag (case insensitive), or whose
email is in `TEST_EMAILS`. Customer tags are not consulted: that would need `read_customers`,
which this app does not request. Tag the order, not the customer. Their spins are flagged `testMode`, use `TEST-` codes
(live codes are the bare eight characters) and titles with `TEST` after the campaign name, and may pass `forceSlice` (1 to 9) to the execute endpoint.
Testers bypass the campaign start date so the flow can be exercised before October 1, but never
the end date, so a stale test link cannot mint a code after the promotion closes. They bypass the
300 CAD minimum only when `TEST_BYPASS_MIN_SUBTOTAL=true`.

```sh
pnpm cleanup:test-data            # dry run
pnpm cleanup:test-data -- --apply # delete TEST discounts, clear test spin records
```

## Checkout UI extension

Both targets call `POST /api/spin/status` with the extension session token and share one
result card, so the two pages can never disagree about a reward. The extension reads the app
server URL from its `app_url` setting: set it in the checkout editor (Thank you page) and in the
customer accounts editor (Order status page) after the first deploy. An optional
`wheel_image_url` setting puts a full-width wheel image at the top of the Thank you banner, above
the heading, large enough to read the slices; the heading, one short line and the button stack
below it. Leave it blank for none. Network access must be
allowed once in the Dev Dashboard under API access.

The Thank you page shows three states: not eligible (encouraging banner), eligible (button
linking to the signed spin URL), already spun (code or gift with expiry and a copy control).
While the order is still being created it shows a "just a moment" banner and polls for about
20 seconds. The Order status page renders the stored reward or nothing at all. A spin can only
start from the Thank you page.

## Spin page (theme app extension)

Add the "Spin to Win wheel" app block to the storefront page that `SPIN_PAGE_URL` points at.
At load the block moves itself into a shadow root on a host element it appends to `<body>`,
with its own `<link>` to `spin-page.css`. Theme CSS cannot reach into the shadow tree, the host
carries `all: initial` so nothing inherits across the boundary, the root sets font, size, colour
and background explicitly, and every size in the stylesheet is in px (the theme controls the
root font-size, so rem would scale with it). Custom properties are the one thing that still
crosses the boundary, so every one the sheet reads is prefixed `--gtsw-` and declared on
`:host`; a test asserts that and that no `var()` carries a fallback. The panel colour itself is
the block's "Background colour" setting in the theme editor, written inline on the root. The result is the same on every theme and matches
the dev preview. Placing the host on `<body>` also matters for the overlay: a theme section
carrying `transform`, `filter` or `overflow` would otherwise trap a fixed layer inside itself.
By default the block renders as a full-screen layer that covers the viewport above every theme
element on a solid black backdrop and locks scroll behind it, so nothing from the storefront
theme is visible and the page reads as a modal opened over checkout rather than a navigation
away from it. The close control returns to the order's own status page. A
background image, colours, copy and the promotion rules URL are block settings; the rules link
renders only when the URL is set.

The page needs `?token=` from the Thank you page. It calls `/apps/spin/state` (invalid, expired
or missing token: a plain message and nothing else; stored result: shown without spinning) and
`/apps/spin/execute` on Spin. The server picks the slice; the page animates to that index with
`spinToItem` and never derives its own outcome. The wheel has nine slices, drawn in reward-table
order (every slice awards something; there is no "try again" slice) with a navy / cream / green
palette by position; labels and icons live in an HTML layer that rotates
with the wheel while each label counter-rotates to stay upright. A failed execute stops the
wheel and shows Try again, which is safe because the server is idempotent. Reduced motion
shortens the animation to a 700 ms settle. `?force=N` is forwarded as `forceSlice` for testers.

## Support: one order ID tells the whole story

Logs are JSON lines and every event about an order carries `orderId` (the numeric order ID).
`grep '"orderId":"5678"'` in the host logs returns, in order:

| Event                                                                                        | What it tells you                                                    |
| -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `http.request`                                                                               | route, HTTP status, latency, error code (one per request)            |
| `spin.eligibility`                                                                           | mode, tester flag, subtotal vs minimum, campaign window, decision    |
| `spin.status` / `spin.state`                                                                 | what the Thank you page or spin page was told                        |
| `spin.execute.outcome`                                                                       | slice, reward, roll, forced flag, the derived code or gift reference |
| `admin.request`                                                                              | every Admin API call: operation, cost, and any `userErrors`          |
| `discount.created` / `discount.duplicate.reused` / `discount.create.failed`                  | the code and its discount node                                       |
| `metafield.written`                                                                          | the spin record is on the order                                      |
| `spin.execute.done`                                                                          | the spin completed                                                   |
| `gift.added` / `gift.confirm.done` / `gift.confirm.unavailable` / `gift.confirm.edit_failed` | the gift step                                                        |
| `status.unauthorized` / `proxy.rejected` / `proxy.invalid_token`                             | rejected requests (no order ID: the request never got that far)      |

A `status.unauthorized` with `reason: "shop"` prints both sides of the comparison:
`tokenDest` (the raw claim), `tokenDestHost` (normalised), `expectedShopDomain` and
`expectedAltDomains`. If `tokenDestHost` is a real host that is not `SHOP_DOMAIN`, add it to
`SHOP_ALT_DOMAINS`. If it is `null`, the token carried no usable `dest` claim.

## Gifts

Gift wins are added to the order through the Order Editing API (`write_order_edits`,
`read_products`). Product and variant identity lives in `GIFT_CATALOG` in
`app/config/campaign.ts`. On a gift spin the record is written with `gift.status = "pending"` and
the order is tagged `gift-pending` before anything else. The spin page then shows the gift step
(glove: hand and size in one step, with out-of-stock combinations disabled; socks and brush:
confirm only). `POST /apps/spin/gift` resolves the variant
(colour by most stock for socks and brush; the glove is White only), adds it at 100% off, commits without notifying the customer,
records the line, and flips the tag to `gift-added`. Out of stock means no edit, a contact-us
message, and the tag stays `gift-pending` for staff.

### Changing scopes (reinstall)

After a scope change in `shopify.app.toml`:

1. `pnpm deploy` creates an app version with the new scopes.
2. In the Dev Dashboard, open the app, then the store under its installs, and approve the scope
   change (or reinstall the app on the store).
3. `pnpm check:scopes` requests a token and lists what the store granted versus what the app needs.
