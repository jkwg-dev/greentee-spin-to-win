# Spin to Win: launch checklist

Everything here needs the store owner or Dev Dashboard access. Work top to bottom. Nothing
below the fold happens before the app is deployed and installed with the right scopes.

## 1. Deploy and scopes

- [ ] `.env` filled in on the host (Vercel, region `pdx1`): `SHOPIFY_API_KEY`, `SHOPIFY_API_SECRET`,
      `SHOP_DOMAIN`, `SPIN_SECRET` (generate once, never rotate), `SPIN_PAGE_URL` (primary domain),
      `APP_URL`, the three `COLLECTION_*` GIDs, `CAMPAIGN_MODE=off`.
- [ ] `shopify.app.toml`: `client_id` linked (`shopify app config link`), `application_url`, auth
      redirect and app proxy URL all point at the Vercel URL.
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
      every `Spin TEST` discount and clears test spin records. Confirm in Discounts.
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
