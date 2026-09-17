import { WorkersAICopyProvider } from "../src/ai/workers-ai-provider";
import { productStateCacheKey } from "../src/cache/cache-key";
import type { CardCache, CacheIdentity, CacheLookup } from "../src/cache/types";
import { workerFetch, type FetchLike } from "../src/network/worker-fetch";
import { processProductLink } from "../src/orchestration/process-product-link";
import { BrowserScreenshotRenderer } from "../src/rendering/browser-renderer";
import type { CardImage, ScreenshotRenderer } from "../src/rendering/types";
import { amazonAsinFromUrl, inspectAmazonHtml, type AmazonHtmlDiagnostics } from "../src/stores/amazon/diagnostics";
import { BrowserAmazonPageLoader } from "../src/stores/amazon/page-loader";
import type { CopyDraft } from "../src/types";

type Env = {
  AI: Ai;
  AI_TEXT_MODEL: string;
  AFFILIATE_DISCLOSURE: string;
  BROWSER: BrowserRun;
};

type BrowserObservation = {
  contentCalls: number;
  screenshotCalls: number;
  lastOriginStatus?: number;
  lastFinalHostname?: string;
  lastFinalHostAllowed?: boolean;
  lastBrowserMsUsed?: number;
  contentDiagnostics?: AmazonHtmlDiagnostics;
};

type FetchObservation = { amazonStatuses: number[]; diagnostics?: AmazonHtmlDiagnostics };

class MemoryCardCache implements CardCache {
  private readonly entries = new Map<string, { shortTitle: string; card: CardImage }>();
  private readonly claims = new Set<string>();

  async lookup(identity: CacheIdentity): Promise<CacheLookup> {
    const entry = this.entries.get(identity.key);
    return entry
      ? { kind: "hit", shortTitle: entry.shortTitle, card: entry.card, ageSeconds: 0, hitCount: 1 }
      : { kind: "miss", reason: "missing" };
  }

  async claim(identity: CacheIdentity): Promise<string | null> {
    if (this.claims.has(identity.key)) return null;
    this.claims.add(identity.key);
    return `pilot-${identity.keyPrefix}`;
  }

  async store(identity: CacheIdentity, _token: string, shortTitle: string, card: CardImage): Promise<void> {
    this.entries.set(identity.key, { shortTitle, card });
    this.claims.delete(identity.key);
  }

  async release(identity: CacheIdentity): Promise<void> { this.claims.delete(identity.key); }

  contains(value: string): boolean {
    for (const [key, entry] of this.entries) {
      if (key.includes(value) || entry.shortTitle.includes(value)) return true;
    }
    return false;
  }
}

function instrumentedBrowser(env: Env, observation: BrowserObservation): BrowserRun {
  return {
    async quickAction(action: "content" | "screenshot", options: BrowserRunContentOptions | BrowserRunScreenshotOptions): Promise<Response> {
      if (action === "content") {
        observation.contentCalls++;
        const response = await env.BROWSER.quickAction("content", options as BrowserRunContentOptions);
        const used = response.headers.get("x-browser-ms-used");
        if (used && /^\d+$/.test(used)) observation.lastBrowserMsUsed = Number(used);
        if (response.ok) {
          const payload = await response.clone().json() as { meta?: { status?: number; finalUrl?: string } };
          observation.lastOriginStatus = payload.meta?.status;
          if (typeof payload.meta?.finalUrl === "string") {
            const hostname = new URL(payload.meta.finalUrl).hostname.toLowerCase();
            observation.lastFinalHostname = hostname;
            observation.lastFinalHostAllowed = hostname === "amazon.com" || hostname.endsWith(".amazon.com");
            if (typeof (payload as { result?: unknown }).result === "string") observation.contentDiagnostics = inspectAmazonHtml((payload as { result: string }).result, payload.meta.finalUrl);
          }
        }
        return response;
      }
      observation.screenshotCalls++;
      const response = await env.BROWSER.quickAction("screenshot", options as BrowserRunScreenshotOptions);
      const used = response.headers.get("x-browser-ms-used");
      if (used && /^\d+$/.test(used)) observation.lastBrowserMsUsed = Number(used);
      return response;
    }
  } as BrowserRun;
}

function observedFetcher(observation: FetchObservation): FetchLike {
  return async (input, init) => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const response = await workerFetch(input, init);
    const hostname = new URL(raw).hostname.toLowerCase();
    if (hostname === "amazon.com" || hostname.endsWith(".amazon.com")) {
      observation.amazonStatuses.push(response.status);
      if (response.ok && response.headers.get("content-type")?.toLowerCase().includes("text/html")) {
        const html = await response.clone().text();
        observation.diagnostics = inspectAmazonHtml(html, raw);
      }
    }
    return response;
  };
}

class ObservedCopyProvider {
  calls = 0;
  inputHadUrl = false;
  constructor(private readonly delegate: WorkersAICopyProvider) {}
  async generate(rawTitle: string, correctionReason?: string): Promise<CopyDraft> {
    this.calls++;
    this.inputHadUrl ||= /https?:\/\/|www\./i.test(rawTitle);
    return this.delegate.generate(rawTitle, correctionReason);
  }
}

class ObservedRenderer implements ScreenshotRenderer {
  calls = 0;
  durationMs = 0;
  constructor(private readonly delegate: BrowserScreenshotRenderer) {}
  async screenshot(html: string, width: number, height: number, requestId?: string): Promise<CardImage> {
    this.calls++;
    const started = Date.now();
    try { return await this.delegate.screenshot(html, width, height, requestId); }
    finally { this.durationMs += Date.now() - started; }
  }
}

function pngSize(bytes: Uint8Array): { width: number; height: number } {
  if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) throw new Error("Rendered output is not a PNG");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

async function runPilot(env: Env) {
  const products = [
    { label: "instant-pot", inputUrl: "https://www.amazon.com/dp/B00FLYWNYQ?th=1&psc=1&ref_=amazon_pilot_a" },
    { label: "bounty", inputUrl: "https://www.amazon.com/dp/B07MHJFRBJ?th=1&psc=1&ref_=amazon_pilot_b" },
    { label: "current-deal-one", inputUrl: "https://www.amazon.com/dp/B0H6W47Y87?th=1&psc=1&ref_=amazon_pilot_c" },
    { label: "current-deal-two", inputUrl: "https://www.amazon.com/dp/B0B4NWBLYJ?th=1&psc=1&ref_=amazon_pilot_d" },
    { label: "fallback-reference", inputUrl: "https://www.amazon.com/dp/B08HNBHSQV?th=1&psc=1&ref_=amazon_pilot_e" }
  ] as const;
  const browserObservation: BrowserObservation = { contentCalls: 0, screenshotCalls: 0 };
  const browser = instrumentedBrowser(env, browserObservation);
  const cache = new MemoryCardCache();
  const copy = new ObservedCopyProvider(new WorkersAICopyProvider(env.AI, env.AI_TEXT_MODEL));
  const renderer = new ObservedRenderer(new BrowserScreenshotRenderer(browser));
  const pageLoader = new BrowserAmazonPageLoader(browser);
  const reports: Array<Record<string, unknown>> = [];
  const cards: Array<{ bytes: Uint8Array; hasOldPrice: boolean }> = [];
  const successful: Array<{ inputUrl: string; asin: string; cacheKeyPrefix: string }> = [];

  for (const product of products) {
    const fetchObservation: FetchObservation = { amazonStatuses: [] };
    const contentBefore = browserObservation.contentCalls;
    const screenshotBefore = browserObservation.screenshotCalls;
    const aiBefore = copy.calls;
    const renderBefore = renderer.calls;
    try {
      const result = await processProductLink(product.inputUrl, {
        fetcher: observedFetcher(fetchObservation),
        copyProvider: copy,
        renderer,
        amazonPageLoader: pageLoader,
        disclosure: env.AFFILIATE_DISCLOSURE || "#Ad",
        requestId: `amazon-pilot-${product.label}`,
        cardCache: cache
      });
      const asin = amazonAsinFromUrl(result.product.resolvedUrl);
      if (!asin) throw new Error("Resolved Amazon ASIN unavailable");
      const identity = await productStateCacheKey(result.product, asin);
      const fallbackUsed = browserObservation.contentCalls > contentBefore;
      reports.push({
        label: product.label,
        success: true,
        asin,
        workerHttpStatus: fetchObservation.amazonStatuses.at(-1),
        workerHtmlAccepted: !fallbackUsed,
        browserFallbackUsed: fallbackUsed,
        browserOriginStatus: fallbackUsed ? browserObservation.lastOriginStatus : undefined,
        finalHostname: new URL(result.product.resolvedUrl).hostname,
        finalHostAllowed: fallbackUsed ? browserObservation.lastFinalHostAllowed : true,
        extractionSource: fallbackUsed ? "browser-content" : "worker-html",
        currentPrice: result.product.currentPrice.formatted,
        oldPrice: result.product.oldPrice?.formatted,
        variantIdentity: asin,
        cacheKeyPrefix: identity.keyPrefix,
        postUrlPreserved: result.product.postUrl === product.inputUrl && result.content.facebookPost.endsWith(product.inputUrl),
        aiCalls: copy.calls - aiBefore,
        renderCalls: renderer.calls - renderBefore,
        browserScreenshotAttempts: browserObservation.screenshotCalls - screenshotBefore
      });
      successful.push({ inputUrl: product.inputUrl, asin, cacheKeyPrefix: identity.keyPrefix });
      cards.push({ bytes: result.card.bytes, hasOldPrice: Boolean(result.product.oldPrice) });
      const successfulReports = reports.filter(report => report.success);
      if (successfulReports.some(report => !report.browserFallbackUsed) && successfulReports.some(report => report.browserFallbackUsed)) break;
    } catch (error) {
      const failure = error as { code?: unknown; stage?: unknown };
      const fallbackUsed = browserObservation.contentCalls > contentBefore;
      reports.push({
        label: product.label,
        success: false,
        asin: amazonAsinFromUrl(product.inputUrl),
        workerHttpStatus: fetchObservation.amazonStatuses.at(-1),
        workerHtmlAccepted: !fallbackUsed,
        browserFallbackUsed: fallbackUsed,
        browserOriginStatus: fallbackUsed ? browserObservation.lastOriginStatus : undefined,
        finalHostname: browserObservation.lastFinalHostname,
        finalHostAllowed: fallbackUsed ? browserObservation.lastFinalHostAllowed : undefined,
        extractionSource: fallbackUsed ? "browser-content" : "worker-html",
        errorCode: String(failure.code ?? "PILOT_PRODUCT_FAILED"),
        errorStage: String(failure.stage ?? "unknown"),
        workerDiagnostics: fetchObservation.diagnostics,
        browserDiagnostics: fallbackUsed ? browserObservation.contentDiagnostics : undefined,
        aiCalls: copy.calls - aiBefore,
        renderCalls: renderer.calls - renderBefore,
        browserScreenshotAttempts: browserObservation.screenshotCalls - screenshotBefore
      });
    }
  }

  let cacheReport: Record<string, unknown> = { tested: false, variantIdentitiesDistinct: false };
  const cacheSource = successful[0];
  if (cacheSource) {
    const repeatUrl = `https://www.amazon.com/dp/${cacheSource.asin}?ref_=amazon_pilot_b`;
    const repeatFetch: FetchObservation = { amazonStatuses: [] };
    const aiBeforeRepeat = copy.calls;
    const renderBeforeRepeat = renderer.calls;
    const screenshotBeforeRepeat = browserObservation.screenshotCalls;
    const repeat = await processProductLink(repeatUrl, {
      fetcher: observedFetcher(repeatFetch), copyProvider: copy, renderer, amazonPageLoader: pageLoader,
      disclosure: env.AFFILIATE_DISCLOSURE || "#Ad", requestId: "amazon-pilot-cache-hit", cardCache: cache
    });
    const repeatAsin = amazonAsinFromUrl(repeat.product.resolvedUrl);
    if (!repeatAsin) throw new Error("Repeat ASIN unavailable");
    const repeatIdentity = await productStateCacheKey(repeat.product, repeatAsin);
    cacheReport = {
      tested: true,
      hit: repeatIdentity.keyPrefix === cacheSource.cacheKeyPrefix,
      aiCallsOnHit: copy.calls - aiBeforeRepeat,
      renderCallsOnHit: renderer.calls - renderBeforeRepeat,
      browserScreenshotCallsOnHit: browserObservation.screenshotCalls - screenshotBeforeRepeat,
      newPostUrlPreserved: repeat.product.postUrl === repeatUrl && repeat.content.facebookPost.endsWith(repeatUrl),
      priorPostUrlAbsent: !repeat.content.facebookPost.includes(cacheSource.inputUrl),
      persistentStateContainsEitherUrl: cache.contains(cacheSource.inputUrl) || cache.contains(repeatUrl),
      variantIdentitiesDistinct: successful.length >= 2 && successful[0].cacheKeyPrefix !== successful[1].cacheKeyPrefix
    };
  }

  const selected = cards.find(card => card.hasOldPrice) ?? cards[0];
  const dimensions = selected ? pngSize(selected.bytes) : { width: 0, height: 0 };
  const successfulReports = reports.filter(report => report.success);
  const pass = successful.length >= 2 && successfulReports.every(report => report.finalHostAllowed && report.postUrlPreserved) &&
    successfulReports.some(report => !report.browserFallbackUsed) && successfulReports.some(report => report.browserFallbackUsed) &&
    !copy.inputHadUrl && cacheReport.hit && cacheReport.aiCallsOnHit === 0 && cacheReport.renderCallsOnHit === 0 &&
    cacheReport.browserScreenshotCallsOnHit === 0 && cacheReport.newPostUrlPreserved && cacheReport.priorPostUrlAbsent &&
    !cacheReport.persistentStateContainsEitherUrl && cacheReport.variantIdentitiesDistinct && dimensions.width === 1200 && dimensions.height === 1200;
  return {
    report: {
      pass,
      products: reports,
      aiInputHadUrl: copy.inputHadUrl,
      cache: cacheReport,
      card: {
        width: dimensions.width,
        height: dimensions.height,
        byteSize: selected?.bytes.length ?? 0,
        browserRenderDurationMs: renderer.durationMs,
        screenshotCalls: browserObservation.screenshotCalls,
        retryNeeded: reports.some(report => Number(report.browserScreenshotAttempts) > 1),
        browserMsUsed: browserObservation.lastBrowserMsUsed
      },
      liveAffiliateLinkExercised: false
    },
    pngBase64: selected ? base64(selected.bytes) : ""
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health" && url.searchParams.get("run") !== "1") return Response.json({ ok: true });
    if (url.pathname !== "/health") return new Response("Not found", { status: 404 });
    try { return Response.json(await runPilot(env)); }
    catch (error) {
      const value = error as { name?: unknown; code?: unknown; stage?: unknown; message?: unknown };
      return Response.json({ error: { name: String(value?.name ?? "Error"), code: String(value?.code ?? "PILOT_FAILED"), stage: String(value?.stage ?? "unknown"), message: String(value?.message ?? "Pilot failed") } }, { status: 500 });
    }
  }
};
