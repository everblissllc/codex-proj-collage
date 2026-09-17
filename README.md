# Affiliate deal card Telegram Worker

One Telegram product link produces a PNG and a separate Facebook post. Walmart and Amazon use authoritative product data and store-specific custom HTML deal cards. e.l.f. Cosmetics uses extracted data and a screenshot of the real mobile product-page section. Bubble is parked and unsupported because its origin returned HTTP 403 to Cloudflare Worker fetch, ordinary Browser Rendering navigation, and its same-origin Shopify product-data endpoint.

## Flow

`POST /telegram/webhook` validates Telegram's secret header and enqueues one job. The Queue consumer resolves up to five HTTP redirects, validates every destination, extracts the supported product, asks the configured copy provider for a short title, renders the retailer's card or product-page section through Browser Run, and sends a photo followed by plain Facebook text. `GET /health` is a simple health response.

The original user URL remains `inputUrl` and becomes `postUrl`; `resolvedUrl` is used for store detection and extraction; `canonicalProductUrl` is optional metadata. The AI never receives the affiliate URL. Telegram URL entities are used to preserve the exact link text when available; a text parser is the fallback. The post URL is appended by code, never rewritten by AI.

For e.l.f., JSON-LD Product offers supply the authoritative price; explicit previous/list prices are optional. A separate Browser Run Quick Actions renderer navigates to the approved e.l.f. product URL with a 430×932 mobile viewport and screenshots the product wrapper containing the gallery and purchase information. It does not recreate the retailer's page in HTML. e.l.f. currently bypasses the D1/R2 card cache because the live page can change independently of extracted price metadata. The page screenshot depends on e.l.f.'s live DOM and Cloudflare Browser Rendering availability; selectors should be rechecked when the site changes.

For Amazon, the submitted `/dp/` or `/gp/product/` URL supplies the trusted ASIN. Safe redirects must remain on Amazon; an explicit conflicting product identity is rejected, while an unconfirmed `/clp/` page retains the submitted ASIN until the Creators API returns the mandatory exact match. The official Amazon Creators API supplies the title, primary large image, featured offer, availability, condition, listing type, deal state, merchant, Buy Box state, and price. The Worker uses OAuth 2.0 client credentials and caches each one-hour access token in memory with a refresh margin. Only an available New, non-MAP, normal one-time featured offer is accepted. Subscribe & Save, restricted Prime deals, unsupported conditions, hidden prices, and non-featured alternatives are rejected. Only a valid higher same-currency `LIST_PRICE` saving basis is retained and labeled “list price”; `WAS_PRICE` is rejected. Browser Rendering only renders the project's 1200×1200 Amazon card HTML; it never navigates Amazon for product data.

Amazon Creators API configuration is intentionally absent from tracked Wrangler files. Configure Worker secrets `AMAZON_CREATORS_CLIENT_ID` and `AMAZON_CREATORS_CLIENT_SECRET`, plus environment values `AMAZON_CREATORS_CREDENTIAL_VERSION`, `AMAZON_CREATORS_MARKETPLACE`, and `AMAZON_CREATORS_PARTNER_TAG`. For the US marketplace, the official values are credential version `3.1` and marketplace `www.amazon.com`; use the credential version shown by Associates Central for the actual credential. Amazon jobs fail safely until all five values are present.

Walmart extraction tries JSON-LD `Product` and `Offer` first, then embedded `__NEXT_DATA__` product state, then OpenGraph and product-price meta tags. The current price must parse as a positive USD amount. Old price is shown only for explicit `wasPrice`, `listPrice`, or `product:original_price:amount` metadata when greater than the current price. A JSON-LD `highPrice` is never treated as an old price. The product image is fetched separately with a size and MIME limit, then embedded as a data URL so Browser Run does not load any outside resource while making the card.

URL validation allows only HTTP(S) public-looking hostnames and rejects URL credentials, all IP literals, local and internal hostnames, and unsafe redirect destinations. Before each product or image request, a fail-closed Cloudflare DNS-over-HTTPS check rejects DNS answers in private or reserved ranges. Cloudflare's outbound fetch restrictions are an additional safeguard. This is not an unrestricted proxy. Dynamic JavaScript redirects and Walmart anti-bot pages may still prevent extraction. No live Walmart page or Browser Run screenshot has been tested in this repository.

## Configuration

`wrangler.jsonc` declares `BROWSER`, the `PRODUCT_JOBS` Queue binding, the Workers AI binding `AI`, `AI_TEXT_MODEL` (default `@cf/meta/llama-3.2-3b-instruct`), `AFFILIATE_DISCLOSURE` (default `#Ad`), and structured Workers logs. `WorkersAICopyProvider` implements the existing `CopyProvider` interface. It asks Workers AI only for a shortened `shortTitle` and validates the JSON and title, with at most one corrective inference for invalid output. Application code builds the Facebook post from that title, the exact extracted formatted price(s), the configured disclosure, and the original affiliate URL. Cloudflare's [JSON Mode support list](https://developers.cloudflare.com/workers-ai/features/json-mode/) does not include this 3B model, so the provider requests JSON in its prompt and validates the returned response. No storage binding is required for the current uncached deployment.

The smoke Queue permits one concurrent consumer invocation; production permits up to five. `max_concurrency` limits simultaneous jobs, not Browser Quick Actions requests per second. Jobs render immediately under normal conditions. Only a Browser HTTP 429 can cause one bounded retry: a valid integer `Retry-After` is honored within 500 ms–5 seconds, otherwise the delay is 1 second, with at most 250 ms jitter. A clear Browser usage-limit 429 is not retried. Cloudflare's [Browser Run Paid limits](https://developers.cloudflare.com/browser-run/limits/) remain account-wide; the queue setting does not guarantee capacity or prevent every 429.

## Optional product-card cache (not provisioned)

When both `CARD_CACHE_DB` (D1) and `CARD_CACHE_BUCKET` (R2) are bound, Walmart uses the existing reusable-card cache. A SHA-256 key over the canonical Walmart product ID, authoritative formatted price state, hashed source title/image identity, and template/title versions selects reusable card state. D1 stores the short title, build lease, timestamps, and opaque R2 key; R2 stores only the PNG. Neither receives the affiliate link or complete Facebook post. The default TTL is 86,400 seconds (24 hours). Amazon card caching is disabled during the initial Creators API rollout so every request validates a fresh official offer.

The cache remains disabled until separate resources are created and **both** bindings are added to the corresponding Wrangler file. The tracked migration is `migrations/0001_card_cache.sql`; apply it to each real D1 database before enabling bindings or deploying a cache-enabled Worker. Future provisioning commands, from an environment where Wrangler runs, are:

```sh
npx wrangler d1 create affiliate-deal-card-smoke-cache
npx wrangler r2 bucket create affiliate-deal-card-smoke-cards
npx wrangler d1 create affiliate-deal-card-cache
npx wrangler r2 bucket create affiliate-deal-card-cards
```

Record each real D1 UUID and decline any prompt to edit Wrangler config automatically. Add `d1_databases` with `binding: CARD_CACHE_DB`, the matching database name and real `database_id`, plus `migrations_dir: migrations`; add `r2_buckets` with `binding: CARD_CACHE_BUCKET` and the matching bucket name. Use only the smoke resources in `wrangler.smoke.jsonc` and only the production resources in `wrangler.jsonc`. Optionally add `CARD_CACHE_TTL_SECONDS: "86400"` to each file's `vars`. Then apply migrations explicitly:

```sh
npx wrangler d1 migrations apply affiliate-deal-card-smoke-cache --remote --config wrangler.smoke.jsonc
npx wrangler d1 migrations apply affiliate-deal-card-cache --remote --config wrangler.jsonc
```

No D1 or R2 resource has been created by this repository change. See Cloudflare's [D1 commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/), [D1 binding configuration](https://developers.cloudflare.com/d1/get-started/), and [R2 bucket commands](https://developers.cloudflare.com/r2/reference/wrangler-commands/).

Required secrets, never committed: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `AMAZON_CREATORS_CLIENT_ID`, and `AMAZON_CREATORS_CLIENT_SECRET`. Amazon also requires `AMAZON_CREATORS_CREDENTIAL_VERSION`, `AMAZON_CREATORS_MARKETPLACE`, and `AMAZON_CREATORS_PARTNER_TAG` as Worker configuration. Workers AI uses the `AI` binding and requires no separate AI API key. The Telegram webhook secret must use Telegram's permitted `A-Z`, `a-z`, `0-9`, `_`, `-` characters. For local development, copy `.dev.vars.example` to `.dev.vars` and replace placeholders. Browser Run local execution requires a remote binding; see [Cloudflare's Browser Run local development guidance](https://developers.cloudflare.com/browser-run/reference/wrangler/).

Cloudflare's [current Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) lists 10,000 Neurons per day included on both Free and Paid plans; usage above that allocation requires Workers Paid and is billed at $0.011 per 1,000 Neurons. The selected 3B model is listed at $0.051 per million input tokens and $0.335 per million output tokens. Workers AI inference uses the Cloudflare account even during local development, so usage can count against the allocation.

Queue jobs are processed one at a time per batch. User-facing failures are acknowledged after a Telegram error message. Queue delivery is at least once, so a rare retry after partial Telegram delivery can duplicate a post; no deduplication store is present in this first version.

## Verification

`npm run typecheck` checks all TypeScript source and tests. `npm test` compiles Worker modules to an isolated temporary folder and runs Node's built-in test runner without esbuild. `npm run test:vitest` is an additional suite and `npm run check` also performs a Wrangler dry run on a supported machine. This macOS 11 host cannot execute the installed esbuild binary, so Vitest, Wrangler type generation, Wrangler dry run, local Worker execution, and live Browser Run verification must be run on a supported machine before production use.

## Temporary hosted smoke test (manual dispatch only)

The [smoke workflow](.github/workflows/smoke-deploy.yml) uses GitHub's `ubuntu-24.04` runner with Node 24. It runs `npm ci`, smoke/production name checks, TypeScript, the Node test suite and TypeScript Vitest suite, and a Wrangler dry run before creating the smoke Queue and deploying the smoke Worker. It runs only on `workflow_dispatch` from the repository's default branch, with the `smoke` GitHub Environment and one concurrent run. It never reads `wrangler.jsonc` for deployment. The project must first be committed to a GitHub repository with these files at its root.

This project directory currently inherits a broader Git repository rooted at `/Users/shop`; it has no `.git` directory of its own. To make this directory a clean standalone repository without changing `/Users/shop/.git`, create an **empty** GitHub repository named `codex-proj-collage` first (do not initialize it with a README, license, or `.gitignore`), then run these commands inside this project. Confirm that `git rev-parse` prints `/Users/shop/Documents/codex-proj-collage` and review the staged filenames before committing. `.dev.vars`, `node_modules`, and `.wrangler` are ignored.

```sh
cd /Users/shop/Documents/codex-proj-collage
git init -b main
git rev-parse --show-toplevel
git add --all
git diff --cached --name-only
git commit -m "Prepare standalone deal-card Worker and smoke workflow"
git remote add origin "https://github.com/YOUR_GITHUB_USERNAME/codex-proj-collage.git"
git push -u origin main
```

`wrangler.smoke.jsonc` deploys only `affiliate-deal-card-smoke` on `workers.dev`, with `affiliate-deal-card-smoke-jobs`, `AI`, `BROWSER`, and `AI_TEXT_MODEL=@cf/meta/llama-3.2-3b-instruct`. It has no production Queue, route, or custom domain. The Queue creation step checks for the exact smoke Queue name and creates it only when absent. Smoke and production Workers use the same source code but separate Worker bindings and Telegram secrets. No Cloudflare resources have been created by this repository preparation.

Create a GitHub Environment named `smoke`, restrict it to the default branch, and optionally require a reviewer. Put **four** secrets in that environment: `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_API_TOKEN`, `TEST_TELEGRAM_BOT_TOKEN`, and `TEST_TELEGRAM_WEBHOOK_SECRET`. The Telegram values must belong to a separate test bot. GitHub's [current environment availability rules](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments) require GitHub Pro, Team, or Enterprise for environment secrets in private repositories; on GitHub Free, a public repository is needed for this exact workflow. Keep all secret values out of Git.

Scope the Cloudflare token to the one Cloudflare account, with Account `Workers Scripts: Edit` and Account `Queues: Edit`. These cover script upload and Queue create/list/consumer configuration. Workers AI and Browser Run bindings do not require separate API keys or additional REST API token permissions when called from the deployed Worker; the account must have those services available. No Zone or Workers Routes permission is needed because the smoke Worker uses `workers.dev` only. The token can still modify other Workers in the same account, so keep the `smoke` Environment restricted and revoke the token after cleanup. Cloudflare documents [Workers GitHub Actions authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [script upload permission](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/content/methods/update/), [Queue creation](https://developers.cloudflare.com/api/resources/queues/methods/create/), and [binding-only Browser Run access](https://developers.cloudflare.com/browser-run/quick-actions/).

After the smoke Worker deploys, the workflow pipes the two test Telegram values from its GitHub Environment directly into `wrangler secret bulk --config wrangler.smoke.jsonc --name affiliate-deal-card-smoke`. Wrangler stores them on the smoke Worker as `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET`; it then verifies that both binding names exist. The values are never written to source, Wrangler config, a file, or workflow logs. The workflow rejects an empty test bot token or a webhook secret outside Telegram's allowed 1–256 character `A-Z`, `a-z`, `0-9`, `_`, `-` range. Cloudflare [states that ordinary Wrangler deploys preserve existing Worker secrets](https://developers.cloudflare.com/workers/wrangler/commands/workers/); this workflow also reapplies both on every successful smoke deployment. No manual Cloudflare Dashboard secret entry is needed.

From a shell with only the **test** bot token and secret in `TEST_BOT_TOKEN` and `TEST_WEBHOOK_SECRET`, register its webhook after replacing the smoke URL with the actual URL printed by Wrangler. Do not run this with production bot credentials:

```sh
curl --fail-with-body --request POST "https://api.telegram.org/bot${TEST_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=https://affiliate-deal-card-smoke.<YOUR_SUBDOMAIN>.workers.dev/telegram/webhook" \
  --data-urlencode "secret_token=${TEST_WEBHOOK_SECRET}" \
  --data-urlencode 'allowed_updates=["message"]'
```

Check that Telegram returns `"ok":true`, then use `getWebhookInfo` for the **test** bot to confirm the smoke URL. The public `GET /health` should return `{"ok":true}`. `/start` currently receives the existing “Please send a valid product link.” response; this confirms basic webhook delivery but is not a special command. Send exactly one real Walmart affiliate URL to the **test** bot. The bot should send a progress message, a PNG card, and a separate `✅ Facebook post:` message with the exact original affiliate URL. Manually compare the card's title, product image, current price, and any genuinely available old price against the Walmart page at test time. An absent old price should simply be omitted.

Cloudflare Worker logs should show one correlated `requestId` across `webhook_accepted`, `queue_job_started`, `redirect_resolved`, `store_detected`, `extraction_complete`, `ai_complete`, `product_image_downloaded`, `render_complete`, `process_complete`, `telegram_photo_sent`, and `telegram_copy_sent`. `redirect_resolved` logs the destination hostname; `store_detected` must report `walmart`. `render_complete` must report `image/png`. Failure logs include `errorCode` and durations where available. Logs intentionally omit the full affiliate URL, credentials, raw product data, and AI text. `process_complete` means card generation finished; the two Telegram events prove delivery separately.

The smoke test passes only when the workflow is green, the hosted Queue runs, the real affiliate URL resolves to Walmart, extraction and Workers AI produce valid data, Browser Run returns PNG, both Telegram messages arrive, and the displayed prices and exact affiliate URL match the live Walmart page and input. Walmart anti-bot responses, redirect services that require JavaScript, or model output that fails strict JSON validation remain possible live failures; report the `requestId` and `errorCode` before changing the extractor or provider.

Cleanup is manual: with the **test** bot token, call `deleteWebhook`; then in the Cloudflare Dashboard delete only the Worker named `affiliate-deal-card-smoke` and Queue named `affiliate-deal-card-smoke-jobs`, verifying each name before deletion. The smoke Worker secrets disappear with that Worker. Remove all four secrets from the GitHub `smoke` Environment and revoke the dedicated Cloudflare token when finished. Do not delete the production Worker or Queue.

```sh
curl --fail-with-body --request POST "https://api.telegram.org/bot${TEST_BOT_TOKEN}/deleteWebhook" \
  --data-urlencode 'drop_pending_updates=true'
```

## Eventual setup and deployment (not performed)

From a supported development environment with Cloudflare and Telegram credentials configured:

```sh
npm ci
npm run typecheck
npm test
npm run test:vitest
npx wrangler types
npx wrangler deploy --dry-run
npx wrangler queues create affiliate-deal-card-jobs
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler deploy
```

Then set the Telegram webhook using the deployed Worker URL (the token and webhook secret are local shell variables in this example):

```sh
curl -X POST "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook" \
  --data-urlencode "url=https://YOUR_WORKER_URL/telegram/webhook" \
  --data-urlencode "secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```
