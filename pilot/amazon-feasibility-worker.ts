import { resolveUrl, readLimitedTextWithSize } from "../src/stores/resolve-url";
import { validatePublicUrl } from "../src/stores/safe-url";

type Env = { BROWSER: BrowserRun };

const PRODUCTS = [
  { label: "ordinary", asin: "B00MNV8E0C", url: "https://www.amazon.com/dp/B00MNV8E0C" },
  { label: "reference-price", asin: "B08HNBHSQV", url: "https://www.amazon.com/dp/B08HNBHSQV" }
] as const;

function inspect(html: string, asin: string) {
  const challengeDetected = /sorry, we just need to make sure you(?:'re| are) not a robot|enter the characters you see below|api-services-support@amazon\.com|to discuss automated access to amazon data|automated access to amazon data|captcha/i.test(html);
  const consentDetected = /before you continue to amazon|choose your cookie preferences/i.test(html);
  const hasAsin = html.includes(asin) && (new RegExp(`data-asin=["']${asin}["']`, "i").test(html) || new RegExp(`["']ASIN["']\\s*:\\s*["']${asin}["']`, "i").test(html));
  const hasTitle = /\bid=["']productTitle["']/i.test(html) || /\bdata-feature-name=["']title["']/i.test(html);
  const hasImage = /\bid=["']landingImage["']/i.test(html) || /\bid=["']imgTagWrapperId["']/i.test(html) || /\bdata-old-hires=/i.test(html);
  const hasPrice = /\bid=["']corePrice[^"']*["']/i.test(html) || /\bclass=["'][^"']*a-price[^"']*["']/i.test(html) || /\bid=["']priceblock_(?:ourprice|dealprice|saleprice)["']/i.test(html);
  const hasPurchaseOffer = /\bid=["'](?:buybox|desktop_buybox|add-to-cart-button)["']/i.test(html) || /\bname=["']submit\.add-to-cart["']/i.test(html);
  return {
    challengeDetected,
    consentDetected,
    hasAsin,
    hasTitle,
    hasImage,
    hasPrice,
    hasPurchaseOffer,
    usableProductPage: !challengeDetected && !consentDetected && hasAsin && hasTitle && hasImage && hasPrice
  };
}

async function workerProbe(product: typeof PRODUCTS[number]) {
  validatePublicUrl(product.url);
  const page = await resolveUrl(product.url);
  const hostname = new URL(page.resolvedUrl).hostname;
  const contentType = page.response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "unknown";
  if (!page.response.ok) {
    await page.response.body?.cancel();
    return { label: product.label, httpStatus: page.response.status, hostname, contentType, responseByteLength: Number(page.response.headers.get("content-length")) || 0, redirectCount: page.redirectCount, challengeDetected: false, usableProductPage: false };
  }
  const { text, byteLength } = await readLimitedTextWithSize(page.response);
  return { label: product.label, httpStatus: page.response.status, hostname, contentType, responseByteLength: byteLength, redirectCount: page.redirectCount, ...inspect(text, product.asin) };
}

async function browserProbe(env: Env, product: typeof PRODUCTS[number]) {
  const response = await env.BROWSER.quickAction("content", {
    url: product.url,
    gotoOptions: { waitUntil: "domcontentloaded", timeout: 20_000 },
    actionTimeout: 10_000,
    cacheTTL: 0
  });
  const browserStatus = response.status;
  const browserMsUsedHeader = response.headers.get("x-browser-ms-used");
  const browserMsUsed = browserMsUsedHeader && /^\d+$/.test(browserMsUsedHeader) ? Number(browserMsUsedHeader) : undefined;
  if (!response.ok) {
    await response.body?.cancel();
    return { label: product.label, browserStatus, browserMsUsed, usableProductPage: false };
  }
  const payload = await response.json() as { success?: boolean; result?: unknown; meta?: { status?: number; finalUrl?: string; redirectChain?: unknown[] } };
  const finalUrl = typeof payload.meta?.finalUrl === "string" ? validatePublicUrl(payload.meta.finalUrl) : undefined;
  const hostname = finalUrl?.hostname;
  const allowedHost = hostname === "amazon.com" || hostname?.endsWith(".amazon.com") === true;
  const html = typeof payload.result === "string" ? payload.result : "";
  const findings = inspect(html, product.asin);
  return {
    label: product.label,
    browserStatus,
    originStatus: payload.meta?.status,
    hostname,
    redirectCount: Array.isArray(payload.meta?.redirectChain) ? payload.meta.redirectChain.length : 0,
    responseByteLength: new TextEncoder().encode(html).byteLength,
    browserMsUsed,
    allowedHost,
    ...findings,
    usableProductPage: Boolean(payload.success && allowedHost && findings.usableProductPage)
  };
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname !== "/probe") return new Response("Not found", { status: 404 });
    const worker = [];
    for (const product of PRODUCTS) {
      try { worker.push(await workerProbe(product)); }
      catch (error) { worker.push({ label: product.label, errorCode: error instanceof Error && "code" in error ? String((error as { code: unknown }).code) : "PROBE_FAILED", usableProductPage: false }); }
    }
    const browser = [];
    if (!worker.every(result => result.usableProductPage)) {
      for (const product of PRODUCTS) {
        try { browser.push(await browserProbe(env, product)); }
        catch { browser.push({ label: product.label, errorCode: "BROWSER_PROBE_FAILED", usableProductPage: false }); }
      }
    }
    return Response.json({ worker, browser });
  }
};
