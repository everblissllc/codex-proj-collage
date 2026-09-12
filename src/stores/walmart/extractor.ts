import { ProductError, type ProductData } from "../../types";
import { validatePublicUrl } from "../safe-url";
import { normalizePrice } from "./price";

function entity(text: string): string {
  return text.replace(/&(?:amp|quot|apos|lt|gt|#39|#x27|#(\d+));/gi, (all, decimal: string) => {
    const map: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&#39;": "'", "&#x27;": "'" };
    return map[all.toLowerCase()] ?? (decimal ? String.fromCodePoint(Number(decimal)) : all);
  });
}
function meta(html: string, key: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(m => [m[1].toLowerCase(), entity(m[3])]));
    if (attrs.property?.toLowerCase() === key || attrs.name?.toLowerCase() === key) return attrs.content;
  }
  return undefined;
}
function jsonLdProducts(html: string): Record<string, unknown>[] {
  const products: Record<string, unknown>[] = [];
  const visit = (item: unknown): void => {
    if (!item || typeof item !== "object") return;
    if (Array.isArray(item)) { item.forEach(visit); return; }
    const node = item as Record<string, unknown>;
    if (node["@type"] === "Product" || (Array.isArray(node["@type"]) && node["@type"].includes("Product"))) products.push(node);
    if (node["@graph"]) visit(node["@graph"]);
  };
  for (const m of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(m[1])); } catch { /* Ignore malformed vendor JSON-LD. */ }
  }
  return products;
}
function str(input: unknown): string | undefined { return typeof input === "string" && input.trim() ? entity(input.trim()) : undefined; }
function image(input: unknown): string | undefined {
  if (Array.isArray(input)) return image(input[0]);
  if (typeof input === "object" && input) return image((input as Record<string, unknown>).url);
  return str(input);
}
function offer(input: unknown): Record<string, unknown> | undefined {
  if (Array.isArray(input)) return offer(input[0]);
  return input && typeof input === "object" ? input as Record<string, unknown> : undefined;
}
function embeddedProduct(html: string): Record<string, unknown> | undefined {
  const script = html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!script) return undefined;
  let root: unknown;
  try { root = JSON.parse(script); } catch { return undefined; }
  const stack: unknown[] = [root];
  let visited = 0;
  while (stack.length && visited++ < 50_000) {
    const node = stack.pop();
    if (!node || typeof node !== "object") continue;
    if (Array.isArray(node)) { stack.push(...node); continue; }
    const record = node as Record<string, unknown>;
    if (typeof record.name === "string" && record.priceInfo && (record.imageInfo || record.imageUrl)) return record;
    stack.push(...Object.values(record));
  }
  return undefined;
}
function priceCandidate(input: unknown): unknown {
  if (input && typeof input === "object") {
    const obj = input as Record<string, unknown>;
    return obj.price ?? obj.value ?? obj.amount;
  }
  return input;
}

export function extractWalmartProduct(html: string, inputUrl: string, resolvedUrl: string): ProductData {
  const products = jsonLdProducts(html);
  const product = products.find(p => p.name && p.image) ?? products[0];
  const offers = offer(product?.offers);
  const embedded = embeddedProduct(html);
  const priceInfo = offer(embedded?.priceInfo);
  const imageInfo = offer(embedded?.imageInfo);
  const rawTitle = str(product?.name) ?? str(embedded?.name) ?? meta(html, "og:title");
  const rawImage = image(product?.image) ?? image(imageInfo?.allImages ?? imageInfo?.thumbnailUrl) ?? image(embedded?.imageUrl) ?? meta(html, "og:image");
  if (!rawTitle) throw new ProductError("MISSING_TITLE", "extraction", "Walmart title unavailable");
  if (!rawImage) throw new ProductError("MISSING_IMAGE", "extraction", "Walmart product image unavailable");
  let imageUrl: string;
  try { imageUrl = validatePublicUrl(new URL(rawImage, resolvedUrl).href).href; }
  catch { throw new ProductError("MISSING_IMAGE", "extraction", "Walmart product image URL invalid"); }
  const currentRaw = priceCandidate(offers?.price ?? offers?.lowPrice) ?? priceCandidate(priceInfo?.currentPrice) ?? meta(html, "product:price:amount");
  if (currentRaw === undefined) throw new ProductError("MISSING_PRICE", "extraction", "Walmart current price unavailable");
  let currentPrice;
  try { currentPrice = normalizePrice(currentRaw, str(offers?.priceCurrency) ?? meta(html, "product:price:currency") ?? "USD"); }
  catch (error) { throw new ProductError("MISSING_PRICE", "extraction", `Walmart current price invalid: ${String(error)}`); }
  // Only explicit was/list prices qualify. JSON-LD highPrice is a range, not an old price.
  const oldRaw = priceCandidate(offers?.wasPrice ?? offers?.listPrice ?? product?.wasPrice ?? product?.listPrice ?? priceInfo?.wasPrice ?? priceInfo?.listPrice) ??
    meta(html, "product:original_price:amount");
  let oldPrice;
  if (oldRaw !== undefined) {
    try {
      const parsed = normalizePrice(oldRaw, currentPrice.currency);
      if (parsed.value > currentPrice.value) oldPrice = parsed;
    } catch { /* A malformed optional old price is omitted, never invented. */ }
  }
  const rawCanonical = str(product?.url) ?? html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)/i)?.[1];
  let canonicalProductUrl: string | undefined;
  if (rawCanonical) {
    try { const url = validatePublicUrl(new URL(rawCanonical, resolvedUrl).href); if (url.hostname === "walmart.com" || url.hostname.endsWith(".walmart.com")) canonicalProductUrl = url.href; } catch { /* Optional. */ }
  }
  return { store: "walmart", inputUrl, resolvedUrl, canonicalProductUrl, postUrl: inputUrl, rawTitle, imageUrl, currentPrice, oldPrice };
}
