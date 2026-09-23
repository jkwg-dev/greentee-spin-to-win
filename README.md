# GreenTee Spin to Win

Standalone Shopify app for the October 1 to November 2, 2026 Wheel of Fortune promotion.
Read `CLAUDE.md` first: it holds the business rules, hard constraints and data model.

## Layout

- `app/config/campaign.ts` — reward table, campaign window, code formats, metafield definition.
- `app/config/env.server.ts` — validated environment (`CAMPAIGN_MODE`, thresholds, test mode).
- `app/lib/outcome.ts` — deterministic HMAC outcome and code derivation.
- `app/routes/` — React Router routes (API endpoints, app proxy).
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

## Campaign mode

`CAMPAIGN_MODE` is `off` (kill switch, default), `test` (only tagged test users see the wheel)
or `live`. `GET /` reports the current mode.
