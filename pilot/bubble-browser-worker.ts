import { BrowserMobilePageRenderer } from "../src/rendering/mobile-page-renderer";
import { BrowserRunPageProductExtractor } from "../src/rendering/browser-page-extractor";
import { bubbleAdapter } from "../src/stores/screenshot/bubble";
import { resolveUrl } from "../src/stores/resolve-url";
import { validatePublicUrl } from "../src/stores/safe-url";
import { ProductError, type ProductData } from "../src/types";

type PilotEnv = { BROWSER: BrowserRun };
type FetchDiagnostics = { httpStatus?: number; hostname?: string; contentType?: string; responseByteLength?: number; redirectCount?: number; extractionSucceeded: boolean };
const SALE_URL = "https://hellobubble.com/products/american-eagle-x-bubble-boxy-tee";
const REGULAR_URL = "https://hellobubble.com/products/water-slide";
const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

async function resolveForBrowser(url: string, diagnostics: FetchDiagnostics): Promise<string> {
  validatePublicUrl(url);
  const page = await resolveUrl(url);
  diagnostics.httpStatus = page.response.status;
  diagnostics.hostname = new URL(page.resolvedUrl).hostname;
  diagnostics.contentType = page.response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() || "unknown";
  diagnostics.redirectCount = page.redirectCount;
  const length = page.response.headers.get("content-length");
  if (length && /^\d+$/.test(length)) diagnostics.responseByteLength = Number(length);
  await page.response.body?.cancel();
  return page.resolvedUrl;
}

export default {
  async fetch(request: Request, env: PilotEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405 });
    if (path === "/health") return new Response("ok");
    if (path !== "/pilot") return new Response("Not found", { status: 404 });

    const saleFetch: FetchDiagnostics = { extractionSucceeded: false };
    const regularFetch: FetchDiagnostics = { extractionSucceeded: false };
    try {
      const browserExtractor = new BrowserRunPageProductExtractor(env.BROWSER);
      const saleTarget = await resolveForBrowser(SALE_URL, saleFetch);
      const sale = await browserExtractor.extractProductPage(saleTarget, SALE_URL, bubbleAdapter, crypto.randomUUID());
      saleFetch.extractionSucceeded = true;
      if (!sale.product.oldPrice || sale.product.oldPrice.value <= sale.product.currentPrice.value) {
        throw new ProductError("PILOT_SALE_PRICE_INVALID", "extraction", "Live Bubble sale did not expose a higher compare-at price");
      }
      const regularTarget = await resolveForBrowser(REGULAR_URL, regularFetch);
      const regular = await browserExtractor.extractProductPage(regularTarget, REGULAR_URL, bubbleAdapter, crypto.randomUUID());
      regularFetch.extractionSucceeded = true;
      console.log(JSON.stringify({
        event: "bubble_pilot_extraction_complete", store: "bubble",
        saleFetch, regularFetch,
        saleCurrentPrice: sale.product.currentPrice.formatted,
        saleOldPrice: sale.product.oldPrice.formatted,
        saleVariantSelection: sale.diagnostics.variantSelection,
        saleHasExplicitVariant: false,
        regularCurrentPrice: regular.product.currentPrice.formatted,
        regularOldPricePresent: Boolean(regular.product.oldPrice),
        success: true
      }));

      const card = await new BrowserMobilePageRenderer(env.BROWSER).screenshotProductPage(saleTarget, bubbleAdapter, crypto.randomUUID());
      if (card.bytes.length < 24 || !PNG_SIGNATURE.every((byte, index) => card.bytes[index] === byte)) {
        throw new ProductError("BROWSER_BAD_IMAGE", "render", "Bubble pilot did not receive a complete PNG");
      }
      const view = new DataView(card.bytes.buffer, card.bytes.byteOffset, card.bytes.byteLength);
      const width = view.getUint32(16);
      const height = view.getUint32(20);
      if (!width || !height) throw new ProductError("BROWSER_BAD_IMAGE", "render", "Bubble pilot PNG dimensions are invalid");
      console.log(JSON.stringify({ event: "bubble_pilot_complete", store: "bubble", hostname: saleFetch.hostname, outputBytes: card.bytes.length, width, height, success: true }));
      const copy = new Uint8Array(card.bytes.byteLength);
      copy.set(card.bytes);
      return new Response(copy.buffer, { headers: {
        "content-type": "image/png", "cache-control": "no-store",
        "x-pilot-sale-http-status": String(saleFetch.httpStatus),
        "x-pilot-sale-content-type": saleFetch.contentType ?? "unknown",
        "x-pilot-sale-response-bytes": String(saleFetch.responseByteLength ?? 0),
        "x-pilot-sale-redirect-count": String(saleFetch.redirectCount ?? 0),
        "x-pilot-sale-current-price": sale.product.currentPrice.formatted,
        "x-pilot-sale-old-price": sale.product.oldPrice.formatted,
        "x-pilot-variant-selection": String(sale.diagnostics.variantSelection ?? "unknown"),
        "x-pilot-regular-http-status": String(regularFetch.httpStatus),
        "x-pilot-regular-current-price": regular.product.currentPrice.formatted,
        "x-pilot-width": String(width), "x-pilot-height": String(height), "x-pilot-bytes": String(card.bytes.length)
      } });
    } catch (error) {
      const known = error instanceof ProductError ? error : undefined;
      const safe = {
        event: "bubble_pilot_failed", store: "bubble", errorCode: known?.code ?? "UNEXPECTED_ERROR", errorStage: known?.stage ?? "unknown",
        saleFetch, regularFetch, browserStatus: known?.browserDiagnostics?.browserStatus, browserReason: known?.browserDiagnostics?.browserReason, success: false
      };
      console.error(JSON.stringify(safe));
      return Response.json(safe, { status: 502, headers: { "cache-control": "no-store" } });
    }
  }
} satisfies ExportedHandler<PilotEnv>;
