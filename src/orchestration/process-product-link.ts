import { ProductError, type GeneratedContent, type ProductData } from "../types";
import { detectStore } from "../stores/detect-store";
import { resolveUrl, readLimitedTextWithSize } from "../stores/resolve-url";
import { validatePublicUrl, type DnsCheck } from "../stores/safe-url";
import { extractWalmartProduct } from "../stores/walmart/extractor";
import { inspectWalmartHtml, walmartProductId } from "../stores/walmart/diagnostics";
import { generateProductCopy } from "../ai/generate-product-copy";
import type { CopyProvider } from "../ai/provider";
import { renderCard } from "../rendering/render-card";
import type { CardImage, ScreenshotRenderer } from "../rendering/types";
import type { FetchLike } from "../network/worker-fetch";

export type ProcessDeps = { fetcher: FetchLike; copyProvider: CopyProvider; renderer: ScreenshotRenderer; disclosure: string; requestId: string; telegramUserId?: number; dnsCheck?: DnsCheck };
export type ProcessResult = { product: ProductData; content: GeneratedContent; card: CardImage };

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
  try {
    validatePublicUrl(inputUrl);
    const directStore = detectStore(inputUrl);
    if (directStore && directStore !== "walmart") throw new ProductError("UNSUPPORTED_STORE", "store", `Unsupported store: ${directStore}`);
    const extractionStart = Date.now();
    const page = await resolveUrl(inputUrl, deps.fetcher, undefined, deps.dnsCheck);
    hostname = new URL(page.resolvedUrl).hostname;
    console.log(JSON.stringify({ event: "redirect_resolved", ...base, hostname }));
    store = detectStore(page.resolvedUrl);
    console.log(JSON.stringify({ event: "store_detected", ...base, hostname, store: store ?? "unsupported" }));
    if (store !== "walmart") {
      await page.response.body?.cancel();
      throw new ProductError("UNSUPPORTED_STORE", "store", `Unsupported store: ${store ?? "unknown"}`);
    }
    const { text: html, byteLength: responseByteLength } = await readLimitedTextWithSize(page.response);
    const contentTypeHeader = page.response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
    const contentType = contentTypeHeader && /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(contentTypeHeader) ? contentTypeHeader : "unknown";
    const diagnostics = inspectWalmartHtml(html, page.resolvedUrl);
    console.log(JSON.stringify({
      event: "walmart_extraction_diagnostics", ...base,
      httpStatus: page.response.status, contentType, responseByteLength, htmlLength: html.length,
      hostname, redirectCount: page.redirectCount, ...diagnostics
    }));
    const product = extractWalmartProduct(html, inputUrl, page.resolvedUrl);
    extractionDurationMs = Date.now() - extractionStart;
    console.log(JSON.stringify({ event: "extraction_complete", ...base, store, hostname, canonicalProductId: walmartProductId(product.canonicalProductUrl ?? product.resolvedUrl), extractionDurationMs }));
    const aiStart = Date.now();
    let content: Awaited<ReturnType<typeof generateProductCopy>>;
    try {
      content = await generateProductCopy(product, deps.copyProvider, deps.disclosure, failure => {
        console.warn(JSON.stringify({ event: "ai_attempt_failed", ...base, ...failure }));
      });
    } finally {
      aiDurationMs = Date.now() - aiStart;
    }
    console.log(JSON.stringify({ event: "ai_complete", ...base, store, aiDurationMs, attemptsUsed: content.attemptsUsed }));
    const renderStart = Date.now();
    let card: CardImage;
    try {
      card = await renderCard(product, content, deps.renderer, deps.fetcher, deps.dnsCheck, deps.requestId);
    } finally {
      renderDurationMs = Date.now() - renderStart;
    }
    console.log(JSON.stringify({ event: "render_complete", ...base, store, renderDurationMs, mimeType: card.mimeType }));
    console.log(JSON.stringify({ event: "process_complete", ...base, store, hostname, extractionDurationMs, aiDurationMs, renderDurationMs, totalDurationMs: Date.now() - started, success: true }));
    return { product, content, card };
  } catch (error) {
    errorStage = error instanceof ProductError ? error.stage : "unknown";
    errorCode = error instanceof ProductError ? error.code : "UNEXPECTED_ERROR";
    console.error(JSON.stringify({ event: "process_failed", ...base, store, hostname, extractionDurationMs, aiDurationMs, renderDurationMs, totalDurationMs: Date.now() - started, success: false, errorStage, errorCode, validationReason: error instanceof ProductError ? error.validationReason : undefined, ...(error instanceof ProductError ? error.browserDiagnostics : undefined) }));
    throw error;
  }
}
