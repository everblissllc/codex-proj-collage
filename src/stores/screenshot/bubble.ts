import { ProductError, type Price, type ProductData } from "../../types";
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
        const rootRecord = record(root);
        const graph = Array.isArray(rootRecord?.["@graph"]) ? rootRecord["@graph"] as unknown[] : [];
        const found = [...graph, root].map(record).find(item => item?.["@type"] === "Product" || (Array.isArray(item?.["@type"]) && item["@type"].includes("Product")));
        if (found) return found;
      }
    } catch { /* Ignore malformed vendor JSON-LD. */ }
  }
  return undefined;
}

function embeddedShopifyProduct(html: string, handle?: string): RecordValue | undefined {
  for (const script of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const root = record(JSON.parse(script[1]));
      const candidates = [root, record(root?.product)].filter((item): item is RecordValue => Boolean(item));
      const match = candidates.find(item => Array.isArray(item.variants) && string(item.title) && (!handle || string(item.handle) === handle));
      if (match) return match;
    } catch { /* Ignore unrelated or malformed application state. */ }
  }
  return undefined;
}

function exactOffer(product: RecordValue | undefined): RecordValue | undefined {
  const offers = Array.isArray(product?.offers) ? product.offers : [product?.offers];
  return offers.map(record).find(offer => offer?.price !== undefined);
}

function shopifyPrice(value: unknown, currency: string | undefined): Price {
  const raw = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value.trim()) ? Number(value) : NaN;
  if (!Number.isSafeInteger(raw) || raw <= 0 || !currency) throw new Error("Invalid Shopify money");
  return normalizePrice(raw / 100, currency);
}

export type BubblePriceSelection = "explicit_variant" | "first_available_variant" | "first_variant" | "json_ld_offer" | "product_meta";

function shopifyOneTimePricing(state: RecordValue | undefined, resolvedUrl: string): { price: unknown; compareAtPrice?: unknown; selection: BubblePriceSelection } | undefined {
  if (!state) return undefined;
  const variants = (Array.isArray(state.variants) ? state.variants : []).map(record).filter((variant): variant is RecordValue => Boolean(variant));
  let requestedVariant: string | null = null;
  try { requestedVariant = new URL(resolvedUrl).searchParams.get("variant"); } catch { /* URL was validated before extraction. */ }
  const explicit = requestedVariant ? variants.find(variant => String(variant.id) === requestedVariant) : undefined;
  const available = explicit ? undefined : variants.find(variant => variant.available !== false);
  const selected = explicit ?? available ?? variants[0];
  const price = selected?.price ?? state.price;
  if (price === undefined) return undefined;
  // Shopify variant.price is the current one-time purchase price. Selling-plan allocations are separate.
  const selection: BubblePriceSelection = explicit ? "explicit_variant" : available ? "first_available_variant" : selected ? "first_variant" : "first_variant";
  return { price, compareAtPrice: selected ? selected.compare_at_price : state.compare_at_price, selection };
}

function productHandle(url: string): string | undefined {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    return parts[0] === "products" && parts[1] ? decodeURIComponent(parts[1]) : undefined;
  } catch { return undefined; }
}

export function bubblePriceSelection(html: string, resolvedUrl: string): BubblePriceSelection | undefined {
  const state = embeddedShopifyProduct(html, productHandle(resolvedUrl));
  const oneTime = shopifyOneTimePricing(state, resolvedUrl);
  if (oneTime) return oneTime.selection;
  if (exactOffer(productJsonLd(html))?.price !== undefined) return "json_ld_offer";
  if (meta(html, "product:price:amount")) return "product_meta";
  return undefined;
}

export function inspectBubbleHtml(html: string): { hasJsonLdProduct: boolean; hasEmbeddedProductState: boolean; hasProductMain: boolean; hasOgTitle: boolean; hasPriceOffer: boolean; hasPurchaseForm: boolean; challengeDetected: boolean } {
  const product = productJsonLd(html);
  return {
    hasJsonLdProduct: Boolean(product),
    hasEmbeddedProductState: Boolean(embeddedShopifyProduct(html)),
    hasProductMain: /<main\b[^>]*(?:id\s*=\s*["']MainContent["']|role\s*=\s*["']main["'])/i.test(html) || /<main\b/i.test(html),
    hasOgTitle: Boolean(meta(html, "og:title")),
    hasPriceOffer: exactOffer(product)?.price !== undefined || Boolean(meta(html, "product:price:amount")),
    hasPurchaseForm: /<form\b[^>]*action\s*=\s*["'][^"']*\/cart\/add(?:[?"'])/i.test(html),
    challengeDetected: /captcha|verify you are human|access denied|press and hold|cf-chl-/i.test(html.slice(0, 100_000))
  };
}

export function extractBubbleProduct(html: string, inputUrl: string, resolvedUrl: string): ProductData {
  const handle = productHandle(resolvedUrl);
  if (!handle || !bubbleAdapter.allowsHost(new URL(resolvedUrl).hostname)) throw new ProductError("NOT_PRODUCT_PAGE", "extraction", "Bubble product URL unavailable");
  const product = productJsonLd(html);
  const state = embeddedShopifyProduct(html, handle);
  const diagnostics = inspectBubbleHtml(html);
  if (!product && !state) throw new ProductError("NOT_PRODUCT_PAGE", "extraction", "Bubble product data unavailable");

  const offer = exactOffer(product);
  const oneTime = shopifyOneTimePricing(state, resolvedUrl);
  const rawTitle = string(product?.name) ?? string(state?.title) ?? meta(html, "og:title");
  if (!rawTitle) throw new ProductError("MISSING_TITLE", "extraction", "Bubble title unavailable");
  const imageValue = first(product?.image);
  const rawImage = string(imageValue) ?? string(record(imageValue)?.url) ?? string(state?.featured_image) ?? string(first(state?.images)) ?? meta(html, "og:image");
  if (!rawImage) throw new ProductError("MISSING_IMAGE", "extraction", "Bubble image unavailable");
  let imageUrl: string;
  try { imageUrl = validatePublicUrl(new URL(rawImage, resolvedUrl).href).href; }
  catch { throw new ProductError("MISSING_IMAGE", "extraction", "Bubble image URL invalid"); }

  const currency = string(offer?.priceCurrency) ?? string(state?.currency) ?? meta(html, "product:price:currency");
  let currentPrice: Price;
  try {
    currentPrice = oneTime
      ? shopifyPrice(oneTime.price, currency)
      : offer?.price !== undefined
        ? normalizePrice(offer.price, currency)
        : normalizePrice(meta(html, "product:price:amount"), currency);
  } catch { throw new ProductError("MISSING_PRICE", "extraction", "Bubble current price invalid"); }

  // Selling-plan allocations are intentionally ignored. Only explicit one-time compare/list fields qualify.
  const oldRaw = oneTime?.compareAtPrice ?? offer?.wasPrice ?? offer?.listPrice ?? offer?.compareAtPrice ?? product?.wasPrice ?? product?.listPrice ?? product?.compareAtPrice;
  let oldPrice: Price | undefined;
  try {
    const candidate = oneTime?.compareAtPrice !== undefined && oneTime.compareAtPrice !== null
      ? shopifyPrice(oneTime.compareAtPrice, currentPrice.currency)
      : oldRaw !== undefined && oldRaw !== null
        ? normalizePrice(oldRaw, currentPrice.currency)
        : meta(html, "product:original_price:amount")
          ? normalizePrice(meta(html, "product:original_price:amount"), currentPrice.currency)
          : undefined;
    if (candidate && candidate.value > currentPrice.value) oldPrice = candidate;
  } catch { /* Optional malformed old price is omitted. */ }

  const rawCanonical = string(product?.url) ?? string(state?.url) ?? html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)/i)?.[1];
  let canonicalProductUrl: string | undefined;
  if (rawCanonical) {
    try {
      const url = validatePublicUrl(new URL(rawCanonical, resolvedUrl).href);
      if (bubbleAdapter.allowsHost(url.hostname)) canonicalProductUrl = url.href;
    } catch { /* Optional canonical URL. */ }
  }
  if (!diagnostics.hasProductMain && !diagnostics.hasPurchaseForm) throw new ProductError("NOT_PRODUCT_PAGE", "extraction", "Bubble product page markers unavailable");
  return { store: "bubble", inputUrl, resolvedUrl, canonicalProductUrl, postUrl: inputUrl, rawTitle, imageUrl, currentPrice, oldPrice };
}

export const bubbleAdapter: ScreenshotStoreAdapter = {
  store: "bubble",
  allowsHost: hostname => hostname === "hellobubble.com" || hostname.endsWith(".hellobubble.com"),
  extract: extractBubbleProduct,
  inspect: inspectBubbleHtml,
  viewport: { width: 430, height: 932, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  readySelector: nonce => `[data-deal-screenshot-store="bubble"][data-deal-image-ready="${nonce}"]`,
  screenshotSelector: nonce => `[data-deal-screenshot-store="bubble"][data-deal-image-ready="${nonce}"]`,
  readyScript: nonce => `(() => {
    const allowedHost = () => location.hostname === 'hellobubble.com' || location.hostname.endsWith('.hellobubble.com');
    const meaningfulImage = region => [...region.querySelectorAll('picture img, img')].find(image =>
      (image.currentSrc || image.src) && (image.naturalWidth >= 200 || !image.complete)
    );
    const candidateFor = (title, form, root) => {
      let candidate = title.parentElement;
      while (candidate) {
        if (candidate.contains(form) && meaningfulImage(candidate)) return candidate;
        if (candidate === root) break;
        candidate = candidate.parentElement;
      }
    };
    const check = () => {
      if (!allowedHost()) return;
      const root = document.querySelector('main#MainContent, main[role="main"], main');
      const title = root?.querySelector('h1');
      const forms = root ? [...root.querySelectorAll('form[action*="/cart/add"]')].filter(form => form.querySelector('button[type="submit"], input[type="submit"]')) : [];
      if (!root || !title || !forms.length) return;
      let region;
      for (const form of forms) {
        const candidate = candidateFor(title, form, root);
        if (candidate && (!region || region.contains(candidate))) region = candidate;
      }
      const image = region && meaningfulImage(region);
      const hasPrice = region && (region.querySelector('[itemprop="price"], [data-product-price], .price, [class*="price"]') || /[$£€]\\s*\\d/.test(region.textContent || ''));
      if (!region || !image || !hasPrice || region.dataset.dealImagePending) return;
      region.dataset.dealImagePending = 'true';
      image.decode().then(() => {
        if (allowedHost() && region.isConnected) {
          region.dataset.dealScreenshotStore = 'bubble';
          region.dataset.dealImageReady = '${nonce}';
        }
      }).catch(() => { delete region.dataset.dealImagePending; });
    };
    new MutationObserver(check).observe(document, { childList: true, subtree: true });
    check();
  })();`
};
