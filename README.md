# saleor-shipstation-app

A Saleor app that pushes orders to ShipStation and writes tracking back to Saleor when shipments dispatch. Phase 1 (post-purchase) only — rate quoting at checkout is not implemented.

**Hosted on Vercel.** Saleor core (API, dashboard, db) runs on a separate Hetzner VPS; this app is a stateless HTTP service that calls Saleor's public GraphQL endpoint and ShipStation's REST API.

## Architecture

```
[Saleor] ORDER_CREATED webhook
   ↓
[App] POST /api/webhooks/saleor/order-created   (JWT-verified by @saleor/app-sdk)
   ↓
[App] → ShipStation v2: POST /v2/shipments
        external_shipment_id = Saleor order UUID
        warehouse_id        = our SS warehouse (ship_from)
        create_sales_order  = true
        Lands in ShipStation → Orders → Awaiting Shipment
        (auto-grouped under ShipStation's "API Shipments" store filter)

──────── operator reviews, picks carrier+service, buys label ────────

[ShipStation] label_created_v2 webhook  (custom header carries shared secret)
   ↓
[App] POST /api/shipstation/shipnotify
   ↓
[App] reads external_shipment_id + tracking_number from payload
       (falls back to GET <resource_url> if inline data is incomplete)
   ↓
[App] → Saleor: orderFulfill (if no fulfillment exists)
                → orderFulfillmentUpdateTracking
```

## Operator workflow

Open ShipStation → **Orders → Awaiting Shipment** → apply the **"API
Shipments"** store filter (ShipStation auto-creates this store the first
time an API-pushed shipment arrives). Each entry is a Saleor order ready
for label purchase. Pin or bookmark the filtered view.

No ShipStation Custom Store / XML feed / store_id configuration is
required — ShipStation handles the auto-store assignment internally for
shipments created via the v2 API with `create_sales_order: true`.

## Endpoints

| Path | Auth | Caller |
|---|---|---|
| `GET /api/manifest` | none (public) | Saleor (during install) |
| `POST /api/register` | Saleor JWT | Saleor (during install) |
| `POST /api/webhooks/saleor/order-created` | Saleor JWT (handled by SDK) | Saleor |
| `POST /api/shipstation/shipnotify` | shared-secret custom header | ShipStation v2 |

## Environment

See `.env.example` for the full list. Required for production:

| Variable | Purpose |
|---|---|
| `APP_API_BASE_URL` | Public HTTPS URL the app is reachable at (Vercel deployment URL or custom domain) |
| `SALEOR_API_URL` | Restricts which Saleor may install the app. `https://api.infinitybiolabs.com/graphql/` for prod. |
| `APL` | `upstash` on Vercel; `file` for local dev only |
| `UPSTASH_URL` | Required when `APL=upstash`. From upstash.com → your DB → REST API |
| `UPSTASH_TOKEN` | Required when `APL=upstash`. Same screen |
| `SHIPSTATION_API_KEY` | ShipStation v2 API key (Account → API Settings). v2 uses a single key — no separate secret. |
| `SHIPSTATION_WEBHOOK_TOKEN` | Shared secret. Generate with `openssl rand -hex 32`. Sent by ShipStation as a custom request header (default `x-webhook-token`). |
| `SHIPSTATION_WEBHOOK_HEADER` | Optional. Header name ShipStation puts the token in. Default `x-webhook-token`. |
| `LOG_LEVEL` | `info` (default) / `debug` / `trace` |

## Deploy to Vercel

### One-time setup

1. **Upstash Redis** (for the APL). Sign up at [upstash.com](https://upstash.com) → **Create Database** → name it (`saleor-shipstation-apl`), choose a region close to your Vercel functions. From the database page, open the **REST API** tab and copy:
   - `UPSTASH_REDIS_REST_URL` → use as `UPSTASH_URL`
   - `UPSTASH_REDIS_REST_TOKEN` → use as `UPSTASH_TOKEN`

2. **Import to Vercel.** Either:
   - From the Vercel dashboard: **Add New → Project → Import Git Repository**, pick `d4lvl13n/saleor-shipstation-app`. Vercel auto-detects Next.js.
   - Or from your laptop: `vercel link` in this directory.

3. **Configure env vars** in Vercel → Project Settings → Environment Variables (Production scope, mark `SHIPSTATION_*` and `UPSTASH_TOKEN` as **Sensitive**):

   ```
   APP_API_BASE_URL=https://<your-vercel-domain>   # set after first deploy
   APL=upstash
   UPSTASH_URL=https://...upstash.io
   UPSTASH_TOKEN=...
   SHIPSTATION_API_KEY=...
   SHIPSTATION_API_SECRET=...
   SHIPSTATION_WEBHOOK_TOKEN=<openssl rand -hex 32>
   ```

4. **First deploy.** Push to `main` — Vercel auto-deploys. After the first deploy, note your Vercel URL and update `APP_API_BASE_URL` to match, then redeploy (Vercel → Deployments → ⋯ → Redeploy).

5. **(Optional) Custom domain.** Vercel → Project Settings → Domains → add `shipstation.infinitybiolabs.com`. Point a CNAME from your DNS provider at `cname.vercel-dns.com`. Vercel handles the TLS cert. Update `APP_API_BASE_URL` to the custom domain and redeploy.

### Subsequent deploys

`git push origin main` → Vercel rebuilds and deploys automatically. PR previews are also generated for `pull_request` events.

## Install into Saleor

1. Once deployed, the app's manifest is served at: `https://<APP_API_BASE_URL>/api/manifest`
2. In Saleor Dashboard → **Apps** → **Install local app**, paste the manifest URL above.
3. Approve the requested permission: `MANAGE_ORDERS`.
4. The SDK saves the auth token in Upstash (`saleor_app_token_<saleorApiUrl>` key).

## Configure ShipStation (v2)

1. **API key.** ShipStation → **Settings → Account → API Settings → Generate API Keys**. Copy the v2 key into `SHIPSTATION_API_KEY` on Vercel. (v2 does not produce a separate secret.)

2. **Webhook token.** Generate locally with `openssl rand -hex 32`. Set as `SHIPSTATION_WEBHOOK_TOKEN` on Vercel.

3. **Register the webhook** via the v2 API (the dashboard UI may not expose `label_created_v2` directly):

   ```bash
   curl -X POST https://api.shipstation.com/v2/environment/webhooks \
     -H 'api-key: <SHIPSTATION_API_KEY>' \
     -H 'Content-Type: application/json' \
     -d '{
       "name": "Saleor tracking sync",
       "event": "label_created_v2",
       "url": "https://<APP_API_BASE_URL>/api/shipstation/shipnotify",
       "headers": [
         { "key": "x-webhook-token", "value": "<SHIPSTATION_WEBHOOK_TOKEN>" }
       ]
     }'
   ```

   This wires ShipStation to call our `/api/shipstation/shipnotify` whenever a label is purchased, with the shared secret in the `x-webhook-token` header.

   Confirm with `curl -H 'api-key: ...' https://api.shipstation.com/v2/environment/webhooks` — you should see the webhook listed.

## Operational notes

- **Single-tenant by design (Phase 1).** The shipnotify handler picks the first APL entry; multi-Saleor installs will need a store-id-to-saleor mapping.
- **Saleor order id is stored in two places** on the ShipStation order: as `orderKey` (canonical) and as `customField1` (human-readable, `saleor:<order-id>`). The shipnotify handler reads `orderKey` to route tracking back.
- **Idempotency:** ShipStation deduplicates `createorder` by `orderNumber` + `orderKey`. Re-firing the Saleor `ORDER_CREATED` webhook is safe.
- **Warehouse selection:** If the order has no existing fulfillment, the app creates one using all unfulfilled lines without specifying a warehouse. Saleor will pick the default. Override in code if your setup needs explicit routing.
- **Cold starts on Vercel:** First invocation after idle adds ~500ms–1s. Fine for ORDER_CREATED (async, Saleor retries) and SHIP_NOTIFY (one-shot, ShipStation retries on 5xx).

## Local development

```bash
cp .env.example .env.local
# Edit .env.local: keep APL=file for local dev, fill in SHIPSTATION_* if testing against ShipStation
pnpm install
pnpm dev   # http://localhost:3100
```

For local Saleor → app testing, use [`saleor-cli` tunnels](https://docs.saleor.io/docs/3.x/developer/extending/apps/developing-apps/app-sdk/local-tunnel) so Saleor can reach `http://localhost:3100`.

The `Dockerfile` and `docker-compose.yml` (if present) are kept for self-hosted use cases; the production deploy target is Vercel.

## Roadmap

- **Phase 2** — Live carrier rates at checkout via `SHIPPING_LIST_METHODS_FOR_CHECKOUT`.
- **Phase 2.x** — Multi-tenant Saleor support; map ShipStation orderKey to the originating Saleor install.
- **Phase 2.x** — Partial-shipment / multi-package handling.
- **Phase 2.x** — Switch from in-line `gql` tagged-template strings to generated typed documents via `graphql-codegen`.

## Attribution

Portions of the ShipStation client and types are adapted from
[`saleor/examples/example-app-shipstation`](https://github.com/saleor/examples/tree/main/example-app-shipstation)
under BSD-3-Clause. See [NOTICE](NOTICE).
