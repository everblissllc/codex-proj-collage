import { ProductError, type ProductData } from "../../types";
import { validatePublicUrl } from "../safe-url";
import { normalizePrice } from "./price";

function entity(text: string): string {
  return text.replace(/&(?:amp|quot|apos|lt|gt|#39|#x27|#(\d+));/gi, (all, decimal: string) => {
    const map: Record<string, string> = { "&amp;": "&", "&quot;": '"', "&apos;": "'", "&lt;": "<", "&gt;": ">", "&#39;": "'", "&#x27;": "'" };
    return map[all.toLowerCase()] ?? (decimal ? String.fromCodePoint(Number(decimal)) : all);
  });
}
export function meta(html: string, key: string): string | undefined {
  for (const tag of html.match(/<meta\b[^>]*>/gi) ?? []) {
    const attrs = Object.fromEntries([...tag.matchAll(/([\w:-]+)\s*=\s*(["'])(.*?)\2/g)].map(m => [m[1].toLowerCase(), entity(m[3])]));
    if (attrs.property?.toLowerCase() === key || attrs.name?.toLowerCase() === key) return attrs.content;
  }
  return undefined;
}
export function jsonLdProducts(html: string): Record<string, unknown>[] {
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
type EmbeddedSelection = {
  root: Record<string, unknown>;
  selected: Record<string, unknown>;
  multiVariant: boolean;
};

function record(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : undefined;
}
function walmartItemId(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "walmart.com" && !parsed.hostname.endsWith(".walmart.com")) return undefined;
    return parsed.pathname.match(/\/ip\/(?:[^/]+\/)?(\d+)(?:\/|$)/i)?.[1];
  } catch { return undefined; }
}
function linkedWalmartItemId(input: unknown, baseUrl: string): string | undefined {
  if (typeof input !== "string") return undefined;
  try { return walmartItemId(new URL(input, baseUrl).href); }
  catch { return undefined; }
}
function variantFailure(message: string): never {
  throw new ProductError("WALMART_VARIANT_MISMATCH", "extraction", message);
}
function embeddedSelection(html: string, resolvedUrl: string): EmbeddedSelection | undefined {
  const script = html.match(/<script\b[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i)?.[1];
  if (!script) return undefined;
  let root: unknown;
  try { root = JSON.parse(script); } catch { return undefined; }
  const parsed = record(root);
  const props = record(parsed?.props);
  const pageProps = record(props?.pageProps);
  const initialData = record(pageProps?.initialData);
  const data = record(initialData?.data);
  const product = record(data?.product) ?? record(pageProps?.product);
  if (!product) return undefined;
  const itemId = walmartItemId(resolvedUrl);
  if (!itemId) variantFailure("Walmart URL item identity is unavailable");
  const rootItemId = str(product.usItemId);
  if (rootItemId && rootItemId !== itemId) variantFailure("Walmart root product does not match the URL item");

  const variantsMap = record(product.variantsMap);
  const variantCount = variantsMap ? Object.keys(variantsMap).length : 0;
  const selectedVariantIds = Array.isArray(product.selectedVariantIds)
    ? product.selectedVariantIds.filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
    : [];
  const displayVariantProductId = str(product.displayVariantProductId);
  const variantProductIdMap = record(product.variantProductIdMap);
  const multiVariant = variantCount > 1 || selectedVariantIds.length > 0 || Boolean(displayVariantProductId);

  if (!multiVariant) {
    if (!rootItemId) variantFailure("Walmart embedded product identity is unavailable");
    return { root: product, selected: product, multiVariant: false };
  }

  if (!rootItemId || !displayVariantProductId || !selectedVariantIds.length || !variantProductIdMap || !variantsMap) {
    variantFailure("Walmart selected variant state is incomplete");
  }
  const mappedIds = selectedVariantIds.map(id => str(variantProductIdMap[id]));
  if (mappedIds.some(id => !id) || mappedIds.some(id => id !== displayVariantProductId)) {
    variantFailure("Walmart selected variant mapping conflicts with the displayed variant");
  }
  const selected = record(variantsMap[displayVariantProductId]);
  if (!selected) variantFailure("Walmart selected variant record is unavailable");
  if (str(selected.usItemId) !== itemId) variantFailure("Walmart selected variant does not match the URL item");
  if (str(selected.id) && str(selected.id) !== displayVariantProductId) variantFailure("Walmart selected variant ID conflicts with the displayed variant");
  const selectedAttributes = Array.isArray(selected.variants) ? selected.variants.filter(value => typeof value === "string") : [];
  if (selectedAttributes.length && selectedVariantIds.some(id => !selectedAttributes.includes(id))) {
    variantFailure("Walmart selected variant attributes conflict with the displayed variant");
  }
  return { root: product, selected, multiVariant: true };
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
  const itemId = walmartItemId(resolvedUrl);
  const identifiedProduct = products.find(product => linkedWalmartItemId(product.url, resolvedUrl) === itemId);
  const selection = embeddedSelection(html, resolvedUrl);
  const product = identifiedProduct ?? (!selection?.multiVariant && products.length === 1 ? products[0] : undefined);
  const offers = offer(product?.offers);
  const selectedPriceInfo = offer(selection?.selected.priceInfo);
  const rootPriceInfo = offer(selection?.root.priceInfo);
  const selectedCurrentPrice = offer(selectedPriceInfo?.currentPrice) ?? offer(rootPriceInfo?.currentPrice);
  const selectedImageInfo = offer(selection?.selected.imageInfo);
  const rootImageInfo = offer(selection?.root.imageInfo);
  const rawTitle = str(selection?.selected.productName) ?? str(selection?.selected.name) ?? str(selection?.root.name) ?? str(product?.name) ?? meta(html, "og:title");
  const rawImage = image(product?.image) ??
    image(selectedImageInfo?.allImages ?? selectedImageInfo?.thumbnailUrl) ??
    image(rootImageInfo?.allImages ?? rootImageInfo?.thumbnailUrl) ??
    image(selection?.selected.imageUrl ?? selection?.root.imageUrl) ?? meta(html, "og:image");
  if (!rawTitle) throw new ProductError("MISSING_TITLE", "extraction", "Walmart title unavailable");
  if (!rawImage) throw new ProductError("MISSING_IMAGE", "extraction", "Walmart product image unavailable");
  let imageUrl: string;
  try { imageUrl = validatePublicUrl(new URL(rawImage, resolvedUrl).href).href; }
  catch { throw new ProductError("MISSING_IMAGE", "extraction", "Walmart product image URL invalid"); }
  const currentRaw = priceCandidate(selectedCurrentPrice) ?? priceCandidate(offers?.price ?? offers?.lowPrice) ??
    (!selection?.multiVariant ? meta(html, "product:price:amount") : undefined);
  if (currentRaw === undefined) throw new ProductError("MISSING_PRICE", "extraction", "Walmart current price unavailable");
  let currentPrice;
  try { currentPrice = normalizePrice(currentRaw, str(selectedCurrentPrice?.currencyUnit) ?? str(offers?.priceCurrency) ?? meta(html, "product:price:currency") ?? "USD"); }
  catch (error) { throw new ProductError("MISSING_PRICE", "extraction", `Walmart current price invalid: ${String(error)}`); }
  // Only explicit was/list prices qualify. JSON-LD highPrice is a range, not an old price.
  const oldRaw = priceCandidate(selectedPriceInfo?.wasPrice ?? selectedPriceInfo?.listPrice) ??
    priceCandidate(rootPriceInfo?.wasPrice ?? rootPriceInfo?.listPrice) ??
    priceCandidate(offers?.wasPrice ?? offers?.listPrice ?? product?.wasPrice ?? product?.listPrice) ??
    (!selection?.multiVariant ? meta(html, "product:original_price:amount") : undefined);
  let oldPrice;
  if (oldRaw !== undefined) {
    try {
      const parsed = normalizePrice(oldRaw, currentPrice.currency);
      if (parsed.value > currentPrice.value) oldPrice = parsed;
    } catch { /* A malformed optional old price is omitted, never invented. */ }
  }
  const rawCanonical = str(selection?.root.canonicalUrl) ?? str(product?.url) ?? html.match(/<link\b[^>]*rel=["']canonical["'][^>]*href=["']([^"']+)/i)?.[1];
  let canonicalProductUrl: string | undefined;
  if (rawCanonical) {
    try { const url = validatePublicUrl(new URL(rawCanonical, resolvedUrl).href); if (url.hostname === "walmart.com" || url.hostname.endsWith(".walmart.com")) canonicalProductUrl = url.href; } catch { /* Optional. */ }
  }
  return { store: "walmart", inputUrl, resolvedUrl, canonicalProductUrl, postUrl: inputUrl, rawTitle, imageUrl, currentPrice, oldPrice };
}
