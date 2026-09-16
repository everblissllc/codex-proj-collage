import type { ProductData } from "../types";
import type { CacheIdentity } from "./types";

export const CARD_CACHE_VERSION = "v1";
export const WALMART_TEMPLATE_VERSION = "walmart-v1";
export const AMAZON_TEMPLATE_VERSION = "amazon-v1";
export const TITLE_GENERATION_VERSION = "title-v1";
export type CacheVersions = { cache: string; template: string; title: string };
const currentVersions = (store: ProductData["store"]): CacheVersions => ({ cache: CARD_CACHE_VERSION, template: store === "amazon" ? AMAZON_TEMPLATE_VERSION : WALMART_TEMPLATE_VERSION, title: TITLE_GENERATION_VERSION });

export function usableWalmartProductId(value: string | undefined): value is string {
  return typeof value === "string" && /^[1-9]\d*$/.test(value);
}

export function usableAmazonProductId(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Z0-9]{10}$/.test(value);
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("");
}

export async function productStateCacheKey(product: ProductData, productId: string, versions: CacheVersions = currentVersions(product.store)): Promise<CacheIdentity> {
  if (product.store === "walmart" && !usableWalmartProductId(productId)) throw new Error("Canonical Walmart product ID unavailable for caching");
  if (product.store === "amazon" && !usableAmazonProductId(productId)) throw new Error("Canonical Amazon ASIN unavailable for caching");
  const [rawTitleHash, imageSourceHash] = await Promise.all([sha256(product.rawTitle), sha256(product.imageUrl)]);
  const source = JSON.stringify({
    cacheVersion: versions.cache,
    store: product.store,
    productId,
    currentPrice: { formatted: product.currentPrice.formatted, currency: product.currentPrice.currency },
    oldPrice: product.oldPrice ? { formatted: product.oldPrice.formatted, currency: product.oldPrice.currency } : null,
    rawTitleHash,
    imageSourceHash,
    templateVersion: versions.template,
    titleGenerationVersion: versions.title
  });
  const key = await sha256(source);
  return { key, keyPrefix: key.slice(0, 12), store: product.store, productId, r2Prefix: `cards/${versions.cache}/${product.store}/${key}/` };
}
