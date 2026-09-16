import { ProductError, type Price, type ProductData } from "../../types";
import { validatePublicUrl } from "../safe-url";
import { jsonLdProducts, meta } from "../walmart/extractor";
import { normalizePrice } from "../walmart/price";
import { amazonAsinFromUrl, inspectAmazonHtml, validAsin } from "./diagnostics";

function entity(value: string): string {
  return value.replace(/&(?:amp|quot|apos|lt|gt|nbsp|#39|#x27|#(\d+));/gi, (all, decimal: string) => {
    const map: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&nbsp;": " ", "&#39;": "'", "&#x27;": "'" };
    return map[all.toLowerCase()] ?? (decimal ? String.fromCodePoint(Number(decimal)) : all);
  });
}
function text(value: string): string { return entity(value.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim(); }
function str(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? entity(value.trim()) : undefined; }
function offer(value: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(value)) return value.map(offer).find(Boolean);
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}
function image(value: unknown): string | undefined {
  if (Array.isArray(value)) return image(value[0]);
  if (value && typeof value === "object") return image((value as Record<string, unknown>).url ?? (value as Record<string, unknown>).contentUrl);
  return str(value);
}
function elementTextById(html: string, id: string): string | undefined {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`<([a-z0-9]+)\\b[^>]*\\bid=["']${escaped}["'][^>]*>([\\s\\S]*?)<\\/\\1>`, "i"));
  const value = match ? text(match[2]) : undefined;
  return value || undefined;
}
function attr(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2];
}
function primaryPriceScope(html: string): string {
  const starts = ["corePrice_feature_div", "corePriceDisplay_desktop_feature_div", "apex_desktop"]
    .map(id => html.search(new RegExp(`\\bid=["']${id}["']`, "i"))).filter(index => index >= 0);
  if (!starts.length) return html.slice(0, 400_000);
  const start = Math.min(...starts);
  return html.slice(start, start + 100_000);
}
function moneyTexts(scope: string, kind: "current" | "old"): string[] {
  const results: string[] = [];
  if (kind === "current") {
    for (const match of scope.matchAll(/<span\b(?=[^>]*\bclass\s*=\s*["'][^"']*(?:priceToPay|apex-pricetopay-value)[^"']*["'])[^>]*>[\s\S]{0,1200}?<span\b[^>]*\bclass\s*=\s*["'][^"']*a-price-whole[^"']*["'][^>]*>([\s\S]*?)<\/span>\s*<span\b[^>]*\bclass\s*=\s*["'][^"']*a-price-fraction[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi)) {
      const whole = text(match[1]).replace(/\D/g, "");
      const fraction = text(match[2]).replace(/\D/g, "").padEnd(2, "0").slice(0, 2);
      if (whole) results.push(`$${whole}.${fraction}`);
    }
  }
  for (const match of scope.matchAll(/<span\b([^>]*)>([\s\S]*?<span\b[^>]*class\s*=\s*["'][^"']*a-offscreen[^"']*["'][^>]*>([\s\S]*?)<\/span>[\s\S]*?)<\/span>/gi)) {
    const outer = match[1];
    const body = match[2];
    const amount = text(match[3]);
    const isOld = /a-text-price|basisPrice|data-a-strike\s*=\s*["']true/i.test(`${outer} ${body}`);
    const excluded = /pricePerUnit|unitPrice|installment|subscribe|sns|usedBuyBox|businessPrice/i.test(`${outer} ${body}`);
    if (!excluded && Boolean(isOld) === (kind === "old") && /^\s*(?:US\s*)?\$\s*\d[\d,]*(?:\.\d{1,2})?\s*$/.test(amount)) results.push(amount);
  }
  return results;
}
function parsedPrice(value: unknown, currency: string): Price | undefined {
  if (value === undefined || value === null) return undefined;
  try { return normalizePrice(value, currency); } catch { return undefined; }
}
function primaryJsonOfferEligible(value: Record<string, unknown> | undefined, hasPurchaseOffer: boolean): boolean {
  if (!value) return false;
  const condition = str(value.itemCondition)?.toLowerCase();
  if (condition && !condition.endsWith("newcondition")) return false;
  const availability = str(value.availability)?.toLowerCase();
  if (availability && /(?:outofstock|soldout|discontinued)/.test(availability)) return false;
  if (availability && /(?:instock|limitedavailability|onlineonly|preorder|presale|backorder)/.test(availability)) return true;
  return hasPurchaseOffer;
}
function canonicalUrl(html: string, resolvedUrl: string): string | undefined {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']canonical["']/i.test(tag)) continue;
    const href = attr(tag, "href");
    if (!href) continue;
    try {
      const url = validatePublicUrl(new URL(href, resolvedUrl).href);
      if (url.hostname === "amazon.com" || url.hostname.endsWith(".amazon.com")) return url.href;
    } catch { /* Optional. */ }
  }
  return undefined;
}
function domImage(html: string): string | undefined {
  const tag = (html.match(/<img\b[^>]*\bid=["']landingImage["'][^>]*>/i) ?? html.match(/<img\b[^>]*\bdata-old-hires=["'][^"']+["'][^>]*>/i))?.[0];
  if (!tag) return undefined;
  const hires = attr(tag, "data-old-hires");
  if (hires) return entity(hires);
  const dynamic = attr(tag, "data-a-dynamic-image");
  if (dynamic) {
    try { const parsed = JSON.parse(entity(dynamic)) as Record<string, unknown>; const first = Object.keys(parsed)[0]; if (first) return first; } catch { /* Fall through. */ }
  }
  return attr(tag, "src");
}

export type AmazonExtraction = { product: ProductData; asin: string; variantSelection: "resolved-url-asin"; priceSource: "json-ld-offer" | "primary-offer-dom" | "product-meta" };

export function extractAmazonProduct(html: string, inputUrl: string, resolvedUrl: string): AmazonExtraction {
  const diagnostics = inspectAmazonHtml(html, resolvedUrl);
  if (diagnostics.challengeDetected) throw new ProductError("AMAZON_CHALLENGE", "extraction", "Amazon returned a challenge page");
  const resolvedAsin = amazonAsinFromUrl(resolvedUrl);
  if (!resolvedAsin) throw new ProductError("MISSING_PRODUCT_ID", "extraction", "Amazon ASIN unavailable");
  if (!diagnostics.pageAsinDetected) throw new ProductError("MISSING_PRODUCT_ID", "extraction", "Amazon page identity unavailable");
  if (diagnostics.canonicalAsin && diagnostics.canonicalAsin !== resolvedAsin) throw new ProductError("VARIANT_MISMATCH", "extraction", "Amazon selected variant does not match the resolved ASIN");
  const products = jsonLdProducts(html);
  const jsonProduct = products.find(product => str(product.sku)?.toUpperCase() === resolvedAsin) ??
    (products.length === 1 && !validAsin(str(products[0].sku)?.toUpperCase()) ? products[0] : undefined);
  const jsonOffer = offer(jsonProduct?.offers);
  const rawTitle = str(jsonProduct?.name) ?? elementTextById(html, "productTitle") ?? meta(html, "og:title");
  const rawImage = image(jsonProduct?.image) ?? domImage(html) ?? meta(html, "og:image");
  if (!rawTitle) throw new ProductError("MISSING_TITLE", "extraction", "Amazon title unavailable");
  if (!rawImage) throw new ProductError("MISSING_IMAGE", "extraction", "Amazon image unavailable");
  let imageUrl: string;
  try { imageUrl = validatePublicUrl(new URL(rawImage, resolvedUrl).href).href; }
  catch { throw new ProductError("MISSING_IMAGE", "extraction", "Amazon image URL invalid"); }
  const scope = primaryPriceScope(html);
  const currency = str(jsonOffer?.priceCurrency) ?? meta(html, "product:price:currency") ?? "USD";
  const jsonCurrent = primaryJsonOfferEligible(jsonOffer, diagnostics.hasPurchaseOffer)
    ? parsedPrice(jsonOffer?.price ?? jsonOffer?.lowPrice, currency)
    : undefined;
  const domCurrent = diagnostics.hasPurchaseOffer
    ? moneyTexts(scope, "current").map(value => parsedPrice(value, currency)).find((value): value is Price => Boolean(value))
    : undefined;
  const metaCurrent = diagnostics.hasPurchaseOffer ? parsedPrice(meta(html, "product:price:amount"), currency) : undefined;
  const currentPrice = jsonCurrent ?? domCurrent ?? metaCurrent;
  const priceSource: AmazonExtraction["priceSource"] = jsonCurrent ? "json-ld-offer" : domCurrent ? "primary-offer-dom" : "product-meta";
  if (!currentPrice) throw new ProductError("MISSING_PRICE", "extraction", "Amazon primary one-time price unavailable");
  // AggregateOffer.highPrice describes an offer range, not a previous price.
  const explicitJsonOld = parsedPrice(jsonOffer?.listPrice ?? jsonProduct?.listPrice, currentPrice.currency);
  const domOld = moneyTexts(scope, "old").map(value => parsedPrice(value, currentPrice.currency)).find((value): value is Price => Boolean(value));
  const candidateOld = explicitJsonOld ?? domOld;
  const oldPrice = candidateOld && candidateOld.value > currentPrice.value ? candidateOld : undefined;
  const canonicalProductUrl = canonicalUrl(html, resolvedUrl);
  const canonicalAsin = amazonAsinFromUrl(canonicalProductUrl) ?? diagnostics.canonicalAsin ?? resolvedAsin;
  if (!validAsin(canonicalAsin) || canonicalAsin !== resolvedAsin) throw new ProductError("VARIANT_MISMATCH", "extraction", "Amazon canonical variant is ambiguous");
  return {
    asin: canonicalAsin,
    variantSelection: "resolved-url-asin",
    priceSource,
    product: { store: "amazon", inputUrl, resolvedUrl, canonicalProductUrl, postUrl: inputUrl, rawTitle, imageUrl, currentPrice, oldPrice }
  };
}
