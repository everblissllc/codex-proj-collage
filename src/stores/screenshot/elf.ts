import { ProductError, type ProductData } from "../../types";
import { validatePublicUrl } from "../safe-url";
import { normalizePrice } from "../walmart/price";
import type { ScreenshotStoreAdapter } from "./types";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue | undefined => value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : undefined;
const first = (value: unknown): unknown => Array.isArray(value) ? value[0] : value;
const string = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const attr = (tag: string, name: string): string | undefined => {
  const match = tag.match(new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, "i"));
  return match?.[2]?.replace(/&amp;/g, "&").replace(/&quot;/g, '"');
};
const meta = (html: string, name: string): string | undefined => {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    if ((attr(tag, "property") ?? attr(tag, "name"))?.toLowerCase() === name) return attr(tag, "content");
  }
  return undefined;
};

function productJsonLd(html: string): RecordValue | undefined {
  for (const script of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed: unknown = JSON.parse(script[1]);
      const roots = Array.isArray(parsed) ? parsed : [parsed];
      for (const root of roots) {
        const entries = [...(record(root)?.["@graph"] && Array.isArray(record(root)?.["@graph"]) ? record(root)!["@graph"] as unknown[] : []), root];
        const found = entries.map(record).find(item => item?.["@type"] === "Product" || (Array.isArray(item?.["@type"]) && item["@type"].includes("Product")));
        if (found) return found;
      }
    } catch { /* Vendor JSON-LD may be malformed. */ }
  }
  return undefined;
}

export function inspectElfHtml(html: string): { hasJsonLdProduct: boolean; hasProductRegion: boolean; hasOgTitle: boolean; hasPriceOffer: boolean; challengeDetected: boolean } {
  const product = productJsonLd(html);
  return {
    hasJsonLdProduct: Boolean(product),
    hasProductRegion: /data-cnstrc-product-detail\s*=\s*["']true["']/i.test(html) && /id\s*=\s*["']product-information["']/i.test(html),
    hasOgTitle: Boolean(meta(html, "og:title")),
    hasPriceOffer: Boolean(record(first(product?.offers))?.price !== undefined),
    challengeDetected: /captcha|verify you are human|access denied|press and hold/i.test(html.slice(0, 100_000))
  };
}

export function extractElfProduct(html: string, inputUrl: string, resolvedUrl: string): ProductData {
  const diagnostics = inspectElfHtml(html);
  const product = productJsonLd(html);
  if (!diagnostics.hasProductRegion) throw new ProductError("NOT_PRODUCT_PAGE", "extraction", "e.l.f. product page markers unavailable");
  const offer = record(first(product?.offers));
  const rawTitle = string(product?.name) ?? meta(html, "og:title");
  if (!rawTitle) throw new ProductError("MISSING_TITLE", "extraction", "e.l.f. title unavailable");
  const imageValue = first(product?.image);
  const rawImage = string(imageValue) ?? string(record(imageValue)?.url) ?? meta(html, "og:image");
  if (!rawImage) throw new ProductError("MISSING_IMAGE", "extraction", "e.l.f. image unavailable");
  let imageUrl: string;
  try { imageUrl = validatePublicUrl(new URL(rawImage, resolvedUrl).href).href; }
  catch { throw new ProductError("MISSING_IMAGE", "extraction", "e.l.f. image URL invalid"); }
  if (offer?.price === undefined || !string(offer.priceCurrency)) throw new ProductError("MISSING_PRICE", "extraction", "e.l.f. current price unavailable");
  let currentPrice;
  try { currentPrice = normalizePrice(offer.price, string(offer.priceCurrency)); }
  catch { throw new ProductError("MISSING_PRICE", "extraction", "e.l.f. current price invalid"); }
  // Only explicit was/list price fields qualify; price ranges and promotions do not.
  const oldRaw = offer?.wasPrice ?? offer?.listPrice ?? product?.wasPrice ?? product?.listPrice ?? meta(html, "product:original_price:amount");
  let oldPrice;
  if (oldRaw !== undefined) {
    try { const parsed = normalizePrice(oldRaw, currentPrice.currency); if (parsed.value > currentPrice.value) oldPrice = parsed; }
    catch { /* Optional malformed old price is omitted. */ }
  }
  const rawCanonical = string(product?.url) ?? html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)/i)?.[1];
  let canonicalProductUrl: string | undefined;
  if (rawCanonical) {
    try { const url = validatePublicUrl(new URL(rawCanonical, resolvedUrl).href); if (elfAdapter.allowsHost(url.hostname)) canonicalProductUrl = url.href; }
    catch { /* Optional canonical URL. */ }
  }
  return { store: "elf", inputUrl, resolvedUrl, canonicalProductUrl, postUrl: inputUrl, rawTitle, imageUrl, currentPrice, oldPrice };
}

export const elfAdapter: ScreenshotStoreAdapter = {
  store: "elf",
  extractionMode: "worker-html",
  allowsHost: hostname => hostname === "elfcosmetics.com" || hostname.endsWith(".elfcosmetics.com"),
  extract: extractElfProduct,
  inspect: inspectElfHtml,
  viewport: { width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  readySelector: nonce => `main [data-cnstrc-product-detail="true"][data-deal-image-ready="${nonce}"] #product-information h1`,
  screenshotSelector: nonce => `main [data-cnstrc-product-detail="true"][data-deal-image-ready="${nonce}"]`,
  readyScript: nonce => `(() => {
    const regionSelector = 'main [data-cnstrc-product-detail="true"]';
    const check = () => {
      if (location.hostname !== 'elfcosmetics.com' && !location.hostname.endsWith('.elfcosmetics.com')) return;
      const region = document.querySelector(regionSelector);
      const image = region?.querySelector('img[loading="eager"]');
      if (!region || !image || !region.querySelector('#product-information h1')) return;
      if (region.dataset.dealImagePending) return;
      region.dataset.dealImagePending = 'true';
      image.decode().then(() => {
        if (location.hostname === 'elfcosmetics.com' || location.hostname.endsWith('.elfcosmetics.com')) {
          region.dataset.dealImageReady = '${nonce}';
        }
      }).catch(() => {});
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
    check();
  })();`
};
