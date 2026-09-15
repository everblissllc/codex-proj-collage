import { ProductError, type ProductData, type BrowserDiagnostics } from "../types";
import { validatePublicUrl } from "../stores/safe-url";
import type { ScreenshotStoreAdapter } from "../stores/screenshot/types";
import {
  boundedBrowserErrorMessage,
  browserMsUsed,
  browserRateLimitDelayMs,
  classifyBrowserError,
  safeBrowserStatusText
} from "./browser-renderer";

export interface BrowserPageProductExtractor {
  extractProductPage(url: string, inputUrl: string, adapter: ScreenshotStoreAdapter, requestId?: string): Promise<BrowserPageExtractionResult>;
}
export type BrowserPageExtractionResult = { product: ProductData; diagnostics: Record<string, string | number | boolean | undefined> };

type ScrapeResponse = {
  success?: unknown;
  result?: Array<{ selector?: unknown; results?: Array<{ text?: unknown }> }>;
  meta?: { status?: unknown; finalUrl?: unknown };
};

const waitForRetry = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

export class BrowserRunPageProductExtractor implements BrowserPageProductExtractor {
  constructor(
    private readonly browser: BrowserRun,
    private readonly wait: (ms: number) => Promise<void> = waitForRetry,
    private readonly random: () => number = () => Math.random()
  ) {}

  async extractProductPage(url: string, inputUrl: string, adapter: ScreenshotStoreAdapter, requestId?: string): Promise<BrowserPageExtractionResult> {
    const target = validatePublicUrl(url);
    if (!adapter.allowsHost(target.hostname)) throw new ProductError("UNSAFE_SCREENSHOT_URL", "extraction", "Browser extraction target is outside the store");
    if (adapter.extractionMode !== "browser-page" || !adapter.browserExtractionSelector || !adapter.browserExtractionScript || !adapter.extractBrowserResult) {
      throw new ProductError("BROWSER_EXTRACTION_UNAVAILABLE", "extraction", "Store does not support browser extraction");
    }
    const nonce = crypto.randomUUID().replace(/-/g, "");
    const selector = adapter.browserExtractionSelector(nonce);
    const options: BrowserRunScrapeOptions = {
      url: target.href,
      viewport: adapter.viewport,
      gotoOptions: { waitUntil: "domcontentloaded", timeout: 20000 },
      waitForSelector: { selector, visible: true, timeout: 12000 },
      elements: [{ selector }],
      setJavaScriptEnabled: true,
      addScriptTag: [{ content: adapter.browserExtractionScript(nonce) }],
      actionTimeout: 15000,
      bestAttempt: false,
      cacheTTL: 0
    };
    const started = Date.now();
    console.log(JSON.stringify({ event: "browser_product_extraction_started", requestId, store: adapter.store, hostname: target.hostname }));
    try {
      for (let attempt = 1; attempt <= 2; attempt++) {
        const attemptStarted = Date.now();
        const response = await this.browser.quickAction("scrape", options);
        if (!response.ok) {
          const message = await boundedBrowserErrorMessage(response).catch(() => "");
          const diagnostics: BrowserDiagnostics = {
            browserStatus: response.status,
            browserStatusText: safeBrowserStatusText(response.statusText),
            browserDurationMs: Date.now() - attemptStarted,
            browserMsUsed: browserMsUsed(response),
            browserReason: classifyBrowserError(response.status, message)
          };
          const retryScheduled = response.status === 429 && diagnostics.browserReason !== "BROWSER_USAGE_LIMIT" && attempt === 1;
          const retryDelayMs = retryScheduled ? browserRateLimitDelayMs(response.headers.get("Retry-After"), this.random()) : undefined;
          console.warn(JSON.stringify({
            event: "browser_product_extraction_attempt_failed", requestId, store: adapter.store, attempt,
            browserStatus: diagnostics.browserStatus, browserReason: diagnostics.browserReason,
            browserDurationMs: diagnostics.browserDurationMs, browserMsUsed: diagnostics.browserMsUsed,
            retryScheduled, retryDelayMs
          }));
          if (retryScheduled && retryDelayMs !== undefined) {
            await this.wait(retryDelayMs);
            continue;
          }
          throw new ProductError("BROWSER_ERROR", "extraction", `Browser Run scrape returned HTTP ${response.status}`, undefined, diagnostics);
        }
        const contentLength = Number(response.headers.get("content-length"));
        if (Number.isFinite(contentLength) && contentLength > 1_000_000) throw new ProductError("BROWSER_EXTRACTION_INVALID", "extraction", "Browser extraction response is too large");
        const body = await response.text();
        if (body.length > 1_000_000) throw new ProductError("BROWSER_EXTRACTION_INVALID", "extraction", "Browser extraction response is too large");
        let parsed: ScrapeResponse;
        try { parsed = JSON.parse(body) as ScrapeResponse; }
        catch { throw new ProductError("BROWSER_EXTRACTION_INVALID", "extraction", "Browser extraction response is not JSON"); }
        const finalUrl = typeof parsed.meta?.finalUrl === "string" ? validatePublicUrl(parsed.meta.finalUrl) : undefined;
        if (!finalUrl || !adapter.allowsHost(finalUrl.hostname)) throw new ProductError("UNSAFE_SCREENSHOT_URL", "extraction", "Browser extraction redirected outside the store");
        if (typeof parsed.meta?.status === "number" && parsed.meta.status >= 400) throw new ProductError("STORE_HTTP_ERROR", "extraction", "Browser product page returned an error");
        const result = parsed.result?.find(item => item.selector === selector)?.results?.[0]?.text;
        if (parsed.success !== true || typeof result !== "string" || !result.trim()) throw new ProductError("BROWSER_EXTRACTION_INVALID", "extraction", "Browser extraction result is missing");
        const product = adapter.extractBrowserResult(result, inputUrl, target.href);
        const resultDiagnostics = adapter.inspectBrowserResult?.(result) ?? {};
        console.log(JSON.stringify({
          event: "browser_product_extraction_complete", requestId, store: adapter.store, hostname: finalUrl.hostname,
          browserDurationMs: Date.now() - started, browserMsUsed: browserMsUsed(response), attemptsUsed: attempt, ...resultDiagnostics, success: true
        }));
        return { product, diagnostics: resultDiagnostics };
      }
      throw new ProductError("BROWSER_ERROR", "extraction", "Browser extraction retry exhausted");
    } catch (error) {
      const diagnostics = error instanceof ProductError ? error.browserDiagnostics : undefined;
      console.error(JSON.stringify({
        event: "browser_product_extraction_failed", requestId, store: adapter.store,
        browserDurationMs: diagnostics?.browserDurationMs ?? Date.now() - started,
        browserStatus: diagnostics?.browserStatus, browserReason: diagnostics?.browserReason ?? (error instanceof ProductError ? error.code : "BROWSER_UNKNOWN_ERROR")
      }));
      throw error;
    }
  }
}
