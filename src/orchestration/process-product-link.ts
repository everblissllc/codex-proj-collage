import { ProductError, type GeneratedContent, type ProductData } from "../types";
import { detectStore } from "../stores/detect-store";
import { resolveUrl, readLimitedTextWithSize } from "../stores/resolve-url";
import { validatePublicUrl, type DnsCheck } from "../stores/safe-url";
import { extractWalmartProduct } from "../stores/walmart/extractor";
import { inspectWalmartHtml, walmartProductId } from "../stores/walmart/diagnostics";
import { generateProductCopy } from "../ai/generate-product-copy";
import { buildFacebookPost } from "../ai/build-facebook-post";
import type { CopyProvider } from "../ai/provider";
import { renderCard } from "../rendering/render-card";
import type { CardImage, ScreenshotRenderer } from "../rendering/types";
import type { FetchLike } from "../network/worker-fetch";
import { productStateCacheKey, usableWalmartProductId } from "../cache/cache-key";
import type { CardCache, CacheIdentity, CacheLookup } from "../cache/types";
import { screenshotStore } from "../stores/screenshot/registry";
import { processScreenshotStore } from "./process-screenshot-store";
import type { MobilePageScreenshotRenderer } from "../rendering/mobile-page-renderer";
import { extractAmazonProduct } from "../stores/amazon/extractor";
import { inspectAmazonHtml, usableAmazonHtml } from "../stores/amazon/diagnostics";
import type { AmazonPageLoader } from "../stores/amazon/page-loader";

export type ProcessDeps = { fetcher: FetchLike; copyProvider: CopyProvider; renderer: ScreenshotRenderer; pageRenderer?: MobilePageScreenshotRenderer; amazonPageLoader?: AmazonPageLoader; disclosure: string; requestId: string; telegramUserId?: number; dnsCheck?: DnsCheck; cardCache?: CardCache };
export type ProcessResult = { product: ProductData; content: GeneratedContent; card: CardImage };

type CacheDecision = { kind: "hit"; result: Extract<CacheLookup, { kind: "hit" }> } | { kind: "claimed"; token: string } | { kind: "bypass" };
const CACHE_WAIT_MAX_MS = 12_000;
const CACHE_POLL_MS = 500;

async function cacheDecision(cache: CardCache, identity: CacheIdentity, requestId: string): Promise<CacheDecision> {
  const fields = { requestId, store: identity.store, canonicalProductId: identity.productId, cacheKeyPrefix: identity.keyPrefix };
  const started = Date.now();
  let loggedMiss = false;
  while (true) {
    let lookup: CacheLookup;
    try { lookup = await cache.lookup(identity, requestId); }
    catch {
      console.error(JSON.stringify({ event: "card_cache_read_failed", ...fields, errorCode: "CACHE_READ_FAILED" }));
      return { kind: "bypass" };
    }
    if (lookup.kind === "hit") {
      console.log(JSON.stringify({ event: "card_cache_hit", ...fields, cacheAgeSeconds: lookup.ageSeconds, hitCount: lookup.hitCount, waitDurationMs: Date.now() - started }));
      return { kind: "hit", result: lookup };
    }
    if (lookup.kind === "corrupt") console.warn(JSON.stringify({ event: "card_cache_corrupt", ...fields }));
    if (!loggedMiss) {
      console.log(JSON.stringify({ event: "card_cache_miss", ...fields, reason: lookup.kind === "miss" ? lookup.reason : lookup.kind }));
      loggedMiss = true;
    }
    const elapsed = Date.now() - started;
    if (elapsed >= CACHE_WAIT_MAX_MS) {
      console.warn(JSON.stringify({ event: "card_cache_build_wait", ...fields, waitDurationMs: elapsed, timedOut: true }));
      return { kind: "bypass" };
    }
    if (lookup.kind !== "building" || lookup.leaseUntil <= Date.now()) {
      try {
        const token = await cache.claim(identity, lookup.kind === "corrupt" ? { updatedAt: lookup.updatedAt, r2Key: lookup.r2Key } : undefined);
        if (token) {
          console.log(JSON.stringify({ event: "card_cache_build_claimed", ...fields, waitDurationMs: Date.now() - started }));
          return { kind: "claimed", token };
        }
      } catch {
        console.error(JSON.stringify({ event: "card_cache_write_failed", ...fields, errorCode: "CACHE_CLAIM_FAILED" }));
        return { kind: "bypass" };
      }
    }
    console.log(JSON.stringify({ event: "card_cache_build_wait", ...fields, waitDurationMs: elapsed }));
    await new Promise(resolve => setTimeout(resolve, Math.min(CACHE_POLL_MS, CACHE_WAIT_MAX_MS - elapsed)));
  }
}

export async function processProductLink(inputUrl: string, deps: ProcessDeps): Promise<ProcessResult> {
  const started = Date.now();
  const base = { requestId: deps.requestId, telegramUserId: deps.telegramUserId };
  let store: ReturnType<typeof detectStore>;
  let hostname: string | undefined;
  let errorStage: string | undefined;
  let errorCode: string | undefined;
  let extractionDurationMs: number | undefined;
  let aiDurationMs: number | undefined;
  let renderDurationMs: number | undefined;
  let cacheIdentity: CacheIdentity | undefined;
  let cacheBuilderToken: string | undefined;
  try {
    validatePublicUrl(inputUrl);
    const directStore = detectStore(inputUrl);
    if (directStore && directStore !== "walmart" && directStore !== "amazon" && !screenshotStore(directStore)) throw new ProductError("UNSUPPORTED_STORE", "store", `Unsupported store: ${directStore}`);
    const extractionStart = Date.now();
    const page = await resolveUrl(inputUrl, deps.fetcher, undefined, deps.dnsCheck);
    hostname = new URL(page.resolvedUrl).hostname;
    console.log(JSON.stringify({ event: "redirect_resolved", ...base, hostname }));
    store = detectStore(page.resolvedUrl);
    console.log(JSON.stringify({ event: "store_detected", ...base, hostname, store: store ?? "unsupported" }));
    const adapter = store ? screenshotStore(store) : undefined;
    if (directStore === "elf" && store !== "elf") {
      await page.response.body?.cancel();
      throw new ProductError("UNSAFE_SCREENSHOT_URL", "url", "Cross-store screenshot redirect rejected");
    }
    if (directStore === "amazon" && store !== "amazon") {
      await page.response.body?.cancel();
      throw new ProductError("UNSAFE_AMAZON_URL", "url", "Amazon redirect left the approved retailer domain");
    }
    if (adapter) {
      const { text: html, byteLength: responseByteLength } = await readLimitedTextWithSize(page.response);
      const diagnostics = adapter.inspect(html);
      const mimeHeader = page.response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      const contentType = mimeHeader && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(mimeHeader) ? mimeHeader : "unknown";
      console.log(JSON.stringify({ event: `${store}_extraction_diagnostics`, ...base, hostname, httpStatus: page.response.status, contentType, responseByteLength, redirectCount: page.redirectCount, ...diagnostics }));
      const product = adapter.extract(html, inputUrl, page.resolvedUrl);
      extractionDurationMs = Date.now() - extractionStart;
      console.log(JSON.stringify({ event: "extraction_complete", ...base, store, hostname, extractionDurationMs }));
      console.log(JSON.stringify({ event: "card_cache_disabled", ...base, store, reason: "SCREENSHOT_STORE_CACHE_DISABLED" }));
      if (!deps.pageRenderer) throw new ProductError("RENDERER_MISSING", "render", "Mobile page renderer unavailable");
      const result = await processScreenshotStore(product, adapter, {
        copyProvider: deps.copyProvider, pageRenderer: deps.pageRenderer,
        disclosure: deps.disclosure, requestId: deps.requestId,
        onAiFailure: failure => console.warn(JSON.stringify({ event: "ai_attempt_failed", ...base, ...failure }))
      });
      aiDurationMs = result.aiDurationMs;
      renderDurationMs = result.renderDurationMs;
      console.log(JSON.stringify({ event: "process_complete", ...base, store, hostname, extractionDurationMs, aiDurationMs, renderDurationMs, cacheStatus: "disabled", totalDurationMs: Date.now() - started, success: true }));
      return { product, content: result.content, card: result.card };
    }
    if (store !== "walmart" && store !== "amazon") {
      await page.response.body?.cancel();
      throw new ProductError("UNSUPPORTED_STORE", "store", `Unsupported store: ${store ?? "unknown"}`);
    }
    let product: ProductData;
    let canonicalProductId: string | undefined;
    if (store === "walmart") {
      const { text: html, byteLength: responseByteLength } = await readLimitedTextWithSize(page.response);
      const contentTypeHeader = page.response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      const contentType = contentTypeHeader && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(contentTypeHeader) ? contentTypeHeader : "unknown";
      const diagnostics = inspectWalmartHtml(html, page.resolvedUrl);
      console.log(JSON.stringify({
        event: "walmart_extraction_diagnostics", ...base,
        httpStatus: page.response.status, contentType, responseByteLength, htmlLength: html.length,
        hostname, redirectCount: page.redirectCount, ...diagnostics
      }));
      product = extractWalmartProduct(html, inputUrl, page.resolvedUrl);
      canonicalProductId = [diagnostics.canonicalProductId, walmartProductId(product.canonicalProductUrl ?? product.resolvedUrl)].find(usableWalmartProductId);
    } else {
      const initialStatus = page.response.status;
      const initialTypeHeader = page.response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      const initialContentType = initialTypeHeader && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(initialTypeHeader) ? initialTypeHeader : "unknown";
      let html = "";
      let responseByteLength = Number(page.response.headers.get("content-length")) || 0;
      if (page.response.ok && /(?:text\/html|application\/xhtml\+xml)/i.test(initialContentType)) {
        const read = await readLimitedTextWithSize(page.response);
        html = read.text;
        responseByteLength = read.byteLength;
      } else await page.response.body?.cancel();
      let amazonDiagnostics = inspectAmazonHtml(html, page.resolvedUrl);
      console.log(JSON.stringify({ event: "amazon_extraction_diagnostics", ...base, hostname, source: "worker-html", httpStatus: initialStatus, contentType: initialContentType, responseByteLength, redirectCount: page.redirectCount, ...amazonDiagnostics }));
      let extractionUrl = page.resolvedUrl;
      if (!usableAmazonHtml(amazonDiagnostics)) {
        if (!deps.amazonPageLoader) throw new ProductError(amazonDiagnostics.challengeDetected ? "AMAZON_CHALLENGE" : "AMAZON_PAGE_UNUSABLE", "extraction", "Amazon Worker response was not a usable product page");
        const browserPage = await deps.amazonPageLoader.load(page.resolvedUrl, deps.requestId);
        html = browserPage.html;
        extractionUrl = browserPage.resolvedUrl;
        hostname = new URL(extractionUrl).hostname;
        amazonDiagnostics = inspectAmazonHtml(html, extractionUrl);
        console.log(JSON.stringify({ event: "amazon_extraction_diagnostics", ...base, hostname, source: "browser-content", httpStatus: browserPage.httpStatus, contentType: "text/html", responseByteLength: browserPage.responseByteLength, redirectCount: browserPage.redirectCount, ...amazonDiagnostics }));
        if (!usableAmazonHtml(amazonDiagnostics)) throw new ProductError(amazonDiagnostics.challengeDetected ? "AMAZON_CHALLENGE" : "AMAZON_PAGE_UNUSABLE", "extraction", "Amazon Browser response was not a usable product page");
      }
      const amazon = extractAmazonProduct(html, inputUrl, extractionUrl);
      product = amazon.product;
      canonicalProductId = amazon.asin;
      console.log(JSON.stringify({ event: "amazon_offer_selected", ...base, hostname, asin: amazon.asin, priceSource: amazon.priceSource, variantSelection: amazon.variantSelection }));
    }
    extractionDurationMs = Date.now() - extractionStart;
    console.log(JSON.stringify({ event: "extraction_complete", ...base, store, hostname, canonicalProductId, extractionDurationMs }));
    let cacheStatus: "hit" | "miss" | "disabled" = "disabled";
    let cacheHit: Extract<CacheLookup, { kind: "hit" }> | undefined;
    if (!canonicalProductId || !deps.cardCache) {
      console.log(JSON.stringify({ event: "card_cache_disabled", ...base, store, canonicalProductId, reason: !canonicalProductId ? "CACHE_PRODUCT_ID_UNAVAILABLE" : "CACHE_BINDINGS_MISSING" }));
    } else {
      try {
        cacheIdentity = await productStateCacheKey(product, canonicalProductId);
        const fields = { ...base, store, canonicalProductId, cacheKeyPrefix: cacheIdentity.keyPrefix };
        console.log(JSON.stringify({ event: "card_cache_lookup", ...fields }));
        const decision = await cacheDecision(deps.cardCache, cacheIdentity, deps.requestId);
        if (decision.kind === "hit") { cacheHit = decision.result; cacheStatus = "hit"; }
        else if (decision.kind === "claimed") { cacheBuilderToken = decision.token; cacheStatus = "miss"; }
      } catch {
        console.error(JSON.stringify({ event: "card_cache_read_failed", ...base, store, canonicalProductId, errorCode: "CACHE_KEY_FAILED" }));
      }
    }
    let content: GeneratedContent;
    let card: CardImage;
    if (cacheHit) {
      content = { shortTitle: cacheHit.shortTitle, facebookPost: buildFacebookPost(product, cacheHit.shortTitle, deps.disclosure) };
      card = cacheHit.card;
      aiDurationMs = 0;
      renderDurationMs = 0;
    } else {
      const aiStart = Date.now();
      let generated: Awaited<ReturnType<typeof generateProductCopy>>;
      try {
        generated = await generateProductCopy(product, deps.copyProvider, deps.disclosure, failure => {
          console.warn(JSON.stringify({ event: "ai_attempt_failed", ...base, ...failure }));
        });
      } finally {
        aiDurationMs = Date.now() - aiStart;
      }
      content = generated;
      console.log(JSON.stringify({ event: "ai_complete", ...base, store, aiDurationMs, attemptsUsed: generated.attemptsUsed }));
      const renderStart = Date.now();
      try {
        card = await renderCard(product, content, deps.renderer, deps.fetcher, deps.dnsCheck, deps.requestId);
      } finally {
        renderDurationMs = Date.now() - renderStart;
      }
      console.log(JSON.stringify({ event: "render_complete", ...base, store, renderDurationMs, mimeType: card.mimeType }));
      if (cacheBuilderToken && cacheIdentity && deps.cardCache) {
        const token = cacheBuilderToken;
        try {
          await deps.cardCache.store(cacheIdentity, token, content.shortTitle, card);
          console.log(JSON.stringify({ event: "card_cache_stored", ...base, store, canonicalProductId, cacheKeyPrefix: cacheIdentity.keyPrefix }));
          cacheBuilderToken = undefined;
        } catch {
          console.error(JSON.stringify({ event: "card_cache_write_failed", ...base, store, canonicalProductId, cacheKeyPrefix: cacheIdentity.keyPrefix, errorCode: "CACHE_STORE_FAILED" }));
          try { await deps.cardCache.release(cacheIdentity, token); }
          catch { console.error(JSON.stringify({ event: "card_cache_write_failed", ...base, store, canonicalProductId, cacheKeyPrefix: cacheIdentity.keyPrefix, errorCode: "CACHE_RELEASE_FAILED" })); }
          cacheBuilderToken = undefined;
        }
      }
    }
    console.log(JSON.stringify({ event: "process_complete", ...base, store, hostname, extractionDurationMs, aiDurationMs, renderDurationMs, cacheStatus, totalDurationMs: Date.now() - started, success: true }));
    return { product, content, card };
  } catch (error) {
    if (cacheBuilderToken && cacheIdentity && deps.cardCache) {
      try { await deps.cardCache.release(cacheIdentity, cacheBuilderToken); }
      catch { console.error(JSON.stringify({ event: "card_cache_write_failed", ...base, store, cacheKeyPrefix: cacheIdentity.keyPrefix, errorCode: "CACHE_RELEASE_FAILED" })); }
    }
    errorStage = error instanceof ProductError ? error.stage : "unknown";
    errorCode = error instanceof ProductError ? error.code : "UNEXPECTED_ERROR";
    console.error(JSON.stringify({ event: "process_failed", ...base, store, hostname, extractionDurationMs, aiDurationMs, renderDurationMs, totalDurationMs: Date.now() - started, success: false, errorStage, errorCode, validationReason: error instanceof ProductError ? error.validationReason : undefined, ...(error instanceof ProductError ? error.browserDiagnostics : undefined) }));
    throw error;
  }
}
