# Spin to Win: launch checklist

Everything here needs the store owner or Dev Dashboard access. Work top to bottom. Nothing
below the fold happens before the app is deployed and installed with the right scopes.

## 1. Deploy and scopes

- [ ] `.env` filled in on the host (Vercel): `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
      `SHOP_DOMAIN`, `SPIN_SECRET` (generate once, never rotate), `SPIN_PAGE_URL` (primary domain),
      `APP_URL`, the three `COLLECTION_*` GIDs, `CAMPAIGN_MODE=off`.
- [ ] `shopify.app.greentee-spin-to-win.toml`: replace every `REPLACE.vercel.app` with the Vercel
      production hostname (three places: `application_url`, the auth redirect, the app proxy URL).
- [ ] Exactly one `shopify.app*.toml` exists. A second one deploys the wrong URLs silently.
- [ ] That file still contains the `[app_proxy]` block and `embedded = false`. `shopify app
  config link` does not write the proxy block, and without it the spin page cannot reach the
      app at all.
- [ ] Vercel project settings match the table in "Vercel project settings" below. The framework
      preset must be React Router; with it unset the build succeeds and every route 404s.
- [ ] `curl https://<app>.vercel.app/` returns `{"ok":true,...}` before touching Shopify.
- [ ] `pnpm deploy` succeeds (app version with scopes `write_orders, write_discounts,
write_order_edits, read_products` and both extensions).
- [ ] Dev Dashboard, the app, Installs, the store: approve the scope change (or reinstall).
- [ ] Dev Dashboard, API access: allow network access for checkout UI extensions.
- [ ] Dev Dashboard, API access: protected customer data, including the email field.
- [ ] `pnpm check:scopes` prints "all required scopes granted".
- [ ] `GET <APP_URL>/` returns `{ ok: true, campaignMode: "off" }`.

## 2. Store setup

- [ ] `pnpm setup:metafields` creates the order definition and the shop `campaign_mode` field.
- [ ] Storefront page exists at `SPIN_PAGE_URL` (e.g. `/pages/spin-to-win`), unlisted from
      navigation, with the **Spin to Win wheel** app block added and overlay mode on.
- [ ] Checkout editor (Thank you page): add the **GreenTee Spin to Win** block and set its
      **Spin to Win server URL** to `APP_URL`.
- [ ] Customer accounts editor (Order status page): add the same block and set the URL again.
- [ ] Shop metafield **Spin to Win campaign mode** set to `test`.

## 3. Test on the live store (campaign mode `test`)

Tag your test customer `test-user` (or add your email to `TEST_EMAILS`; that route only works
once protected customer data with the email field is approved, so prefer the tag). Set
`TEST_BYPASS_MIN_SUBTOTAL=true` while testing cheap orders.

- [ ] Order at $299.99 and at $300.00 with a non-test customer: the first is ineligible, the
      second is not shown at all while mode is `test` (only testers see the wheel).
- [ ] Test order: Thank you page shows the spin banner on desktop and on a phone.
- [ ] Spin lands, code is shown; refresh the spin page shows the same result; Thank you page
      and Order status page both show the code.
- [ ] Code applies at checkout only to the matching regular priced collection, once.
- [ ] `?force=2` on the spin page as a tester lands on gloves: size chips, confirm, the order
      gains a $0 glove line and the tag flips to `gift-added`. Repeat with `?force=5` (socks)
      and `?force=4` (brush).
- [ ] A non-test customer with `?force=` gets a plain error and can still spin normally.
- [ ] Order editing works on an order paid through **Shop Pay** (the accelerated checkout is the
      most common path from a phone).
- [ ] Close the page before confirming a gift: the order carries `gift-pending`; reopen from
      the Thank you page and finish it.
- [ ] Flip the shop metafield to `off`: banners disappear within a minute, stored codes still
      show. Flip back to `test`.

## 4. Before October 1

- [ ] `pnpm cleanup:test-data` (dry run), then `pnpm cleanup:test-data -- --apply`: deletes
      every `Spin TEST` discount and clears test spin records. Confirm in Discounts. Run it again
      after any change to the reward table (the wheel went from ten slices to nine on
      September 23) so no test record carries indices from an older table.
- [ ] Remove the `test-user` tag from any real customer accounts used for testing, or leave
      it only on staff accounts.
- [ ] `TEST_BYPASS_MIN_SUBTOTAL=false` on the host.
- [ ] Share `docs/OPERATIONS.md` with the fulfilment team.

## 5. Launch morning, October 1

- [ ] Shop metafield **Spin to Win campaign mode** to `live`.
- [ ] Place one real order over $300 and watch the logs for that order ID.

## 6. Close, November 2 after 9:00 AM Pacific

- [ ] Codes expire on their own. Set campaign mode to `off` once the last gifts are added.
- [ ] Export orders with `tag:gift-pending` and resolve them by hand.
- [ ] Reporting: export order metafields `greentee_spin.result`.

## Vercel project settings

Settings, General. Leave anything not listed on its default.

| Setting          | Value                            | Why                                                                                                                       |
| ---------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Framework Preset | **React Router**                 | Required. It runs the builder that turns the build into a function. Without it there is no function and every route 404s. |
| Build Command    | default (`react-router build`)   | `package.json` `build` is the same command. Do not override.                                                              |
| Output Directory | default                          | The framework preset knows it. An explicit value breaks the function.                                                     |
| Install Command  | `pnpm install --frozen-lockfile` | Set in `vercel.json`. Fails the build on a stale lockfile.                                                                |
| Node.js Version  | 22.x                             | Matches `engines` in `package.json`.                                                                                      |
| Root Directory   | repository root                  | `vercel.json` and `react-router.config.ts` live there.                                                                    |

`vercel.json` already pins the framework and install command, so a fresh project import picks
them up. If the dashboard shows Framework Preset as "Other", change it to React Router: a
dashboard value set before `vercel.json` existed can win.

### Regions

`"regions": ["pdx1"]` in `vercel.json` sets where **functions run** (Portland, closest to
Vancouver). It does not affect the **build machine**, which Vercel places itself and which the
log reports as `iad1`. A build in `iad1` with functions in `pdx1` is correct and needs no change.
Confirm after deploying: the deployment's Functions tab should list `pdx1`.

### Environment variables

Set these in Settings, Environment Variables for Production (and Preview if you test there).
`SPIN_SECRET` must never change once the campaign is live: it derives every outcome.

`CAMPAIGN_MODE`, `CAMPAIGN_START`, `CAMPAIGN_END`, `MIN_SUBTOTAL_CAD`, `TEST_TAG`,
`TEST_EMAILS`, `TEST_BYPASS_MIN_SUBTOTAL`, `COLLECTION_CLUBS`, `COLLECTION_ACCESSORIES`,
`COLLECTION_APPAREL`, `SPIN_SECRET`, `APP_URL`, `SPIN_PAGE_URL`, `SHOPIFY_API_KEY`,
`SHOPIFY_API_SECRET`, `SHOP_DOMAIN`, and `SHOP_ALT_DOMAINS` only if the logs ask for it.
