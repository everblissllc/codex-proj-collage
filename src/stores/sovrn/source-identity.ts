import { ProductError } from "../../types";
import { inspectHomeDepotProduct } from "../homedepot/extractor";
import { assessHomeDepotSovrnIdentity } from "../homedepot/sovrn-identity";
import { hostnameMatches, sovrnMerchantAdapters } from "./merchant-registry";
import type { ProductData } from "../../types";
import type { SovrnIdentityAssessment, SovrnSourceEvidence, SovrnStoreId, SovrnVariantClassification, SovrnVariantEvidence, SovrnWireOffer } from "./types";

type SafeProductIdentity = { name?: string; sku?: string; productId?: string; gtin?: string; mpn?: string; size?: string; color?: string };
const decodeHtml = (value: string): string => value.replace(/&quot;|&#34;/gi, '"').replace(/&apos;|&#39;/gi, "'")
  .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#8211;|&ndash;|&mdash;/gi, "-");
const clean = (value: unknown): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = decodeHtml(String(value)).replace(/\s+/g, " ").trim();
  return result ? result.slice(0, 300) : undefined;
};
function attributes(tag: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) output[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? "");
  return output;
}
function productNodes(value: unknown, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) { value.forEach(child => productNodes(child, output)); return output; }
  if (!value || typeof value !== "object") return output;
  const item = value as Record<string, unknown>;
  const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
  if (types.some(type => typeof type === "string" && type.toLowerCase() === "product")) output.push(item);
  for (const child of Object.values(item)) if (child && typeof child === "object") productNodes(child, output);
  return output;
}
function jsonLdProducts(html: string): SafeProductIdentity[] {
  const products: SafeProductIdentity[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      for (const item of productNodes(JSON.parse(decodeHtml(match[1]).trim()))) products.push({
        name: clean(item.name), sku: clean(item.sku), productId: clean(item.productID ?? item.productId),
        gtin: clean(item.gtin ?? item.gtin8 ?? item.gtin12 ?? item.gtin13 ?? item.gtin14), mpn: clean(item.mpn ?? item.model),
        size: clean(item.size), color: clean(item.color)
      });
    } catch { /* Malformed unrelated JSON-LD is not product identity evidence. */ }
  }
  return products.slice(0, 10);
}
function canonicalUrl(html: string, base: URL): URL | undefined {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if (!attrs.rel?.split(/\s+/).some(value => value.toLowerCase() === "canonical") || !attrs.href) continue;
    try { return new URL(attrs.href, base); } catch { return undefined; }
  }
  return undefined;
}
function sizeFromValue(value?: string): string | undefined {
  const match = value?.replace(/[_-]+/g, " ").match(/(\d+(?:\.\d+)?)\s*(fl\.?\s*oz\.?|oz\.?|ml|inch(?:es)?|in\.?)\b/i);
  return match ? `${match[1]} ${match[2].replace(/\./g, "").replace(/\s+/g, " ")}` : undefined;
}
const normalizedVariant = (value: string): string => value.trim().toLowerCase().replace(/fluid ounces?|fl\.?\s*oz\.?/g, "floz")
  .replace(/ounces?|oz\.?/g, "oz").replace(/millilit(?:er|re)s?|ml/g, "ml").replace(/inch(?:es)?|in\.?/g, "in").replace(/[^a-z0-9.]+/g, "");
const normalizedName = (value: string): string => decodeHtml(value).toLowerCase().replace(/\b(?:at\s+)?(?:walmart|walmart\.com)\b/g, " ")
  .replace(/[^a-z0-9]+/g, " ").trim();

const titleStopwords = new Set(["a", "an", "and", "for", "of", "the", "with"]);
function reorderedTitleMatch(left: string, right: string): boolean {
  const tokens = (value: string): string[] => [...new Set(normalizedName(value).split(" ").filter(token => token && !titleStopwords.has(token)))];
  const leftTokens = tokens(left);
  const rightTokens = tokens(right);
  if (leftTokens.length < 5 || rightTokens.length < 5 || leftTokens[0] !== rightTokens[0]) return false;
  const rightSet = new Set(rightTokens);
  const shared = leftTokens.filter(token => rightSet.has(token)).length;
  return shared >= 5 && shared / Math.min(leftTokens.length, rightTokens.length) >= 0.8;
}

export function inspectSovrnSource(input: { store: SovrnStoreId; sourceProduct: ProductData; postUrl: string; resolvedUrl: string; html: string }): SovrnSourceEvidence {
  const resolved = new URL(input.resolvedUrl);
  const submitted = new URL(input.postUrl);
  const adapter = sovrnMerchantAdapters[input.store];
  if (!adapter.domains.some(domain => hostnameMatches(resolved.hostname, domain))) throw new ProductError("SOVRN_PRODUCT_MISMATCH", "extraction", "Resolved source retailer changed");
  const productId = adapter.productIdentity(resolved) ?? adapter.productIdentity(submitted);
  const canonical = canonicalUrl(input.html, resolved);
  const canonicalId = canonical && adapter.domains.some(domain => hostnameMatches(canonical.hostname, domain)) ? adapter.productIdentity(canonical) : undefined;
  const products = jsonLdProducts(input.html);
  const names = [input.sourceProduct.rawTitle];
  const size = products.find(product => product.size)?.size ?? sizeFromValue(input.html.match(/"dimensionsValue"\s*:\s*"([^"]+)"/i)?.[1]);
  const color = products.find(product => product.color)?.color ?? clean(input.html.match(/"color"\s*:\s*"([^"]+)"/i)?.[1]);
  const mpn = products.find(product => product.mpn)?.mpn ?? clean(input.html.match(/"(?:model|modelNumber|mpn)"\s*:\s*"([^"]+)"/i)?.[1]);
  const sku = products.find(product => product.sku)?.sku;
  const normalizedProductId = productId?.toLowerCase();
  const sourceProductIds = [input.sourceProduct.resolvedUrl, input.sourceProduct.canonicalProductUrl]
    .flatMap(value => {
      if (!value) return [];
      try { return [adapter.productIdentity(new URL(value))]; }
      catch { return []; }
    })
    .filter((value): value is string => Boolean(value));
  const productIdConfirmed = Boolean(normalizedProductId && sourceProductIds.some(value => value.toLowerCase() === normalizedProductId) && (
    canonicalId?.toLowerCase() === normalizedProductId ||
    products.some(product => [product.productId, product.sku].some(value => value?.toLowerCase() === normalizedProductId)) ||
    input.html.toLowerCase().includes(normalizedProductId)
  ));
  let homeDepot;
  if (input.store === "homedepot") {
    try { homeDepot = inspectHomeDepotProduct(input.html, input.resolvedUrl); }
    catch { /* The provider will fail closed when deterministic source evidence is unavailable. */ }
  }
  return {
    store: input.store, productId, productIdConfirmed, productNames: names,
    variant: { explicit: Boolean(size || color || mpn), multiVariantFamily: false, size, color, sku, gtin: products.find(product => product.gtin)?.gtin, mpn },
    homeDepot
  };
}

export function classifySovrnVariant(source: SovrnVariantEvidence, offer: SovrnVariantEvidence): SovrnVariantClassification {
  const keys: Array<keyof Omit<SovrnVariantEvidence, "explicit" | "multiVariantFamily">> = ["size", "shade", "color", "pack", "container", "variantId", "sku", "upc", "gtin", "mpn"];
  let matching = false;
  for (const key of keys) {
    const left = source[key], right = offer[key];
    if (typeof left !== "string" || typeof right !== "string") continue;
    if (normalizedVariant(left) !== normalizedVariant(right)) return "VARIANT_CONFLICT";
    matching = true;
  }
  const sourceHasSelectedVariant = Boolean(source.size || source.shade || source.color || source.pack || source.container || source.mpn);
  const offerNamesSpecificVariant = Boolean(offer.size || offer.shade || offer.color || offer.pack || offer.container || offer.mpn);
  if (source.multiVariantFamily && !sourceHasSelectedVariant && offerNamesSpecificVariant) return "VARIANT_AMBIGUOUS_HIGH_RISK";
  if (source.explicit && offer.explicit && matching) return "EXACT_VARIANT_MATCH";
  return "NO_VARIANT_CONFLICT";
}

function offerVariant(offer: SovrnWireOffer, source: SovrnSourceEvidence): SovrnVariantEvidence {
  const title = offer.title ?? "";
  const normalizedTitle = normalizedName(title);
  const size = sizeFromValue(title);
  const matchingColor = source.variant.color && normalizedTitle.includes(normalizedName(source.variant.color)) ? source.variant.color : undefined;
  const namedColor = title.match(/\b(black|white|red|blue|green|silver|gr[ae]y|pink|purple|gold|brown|beige)\b/gi)?.at(-1);
  const color = matchingColor ?? namedColor;
  const inferredMpn = source.variant.mpn && normalizedTitle.includes(normalizedName(source.variant.mpn)) ? source.variant.mpn : undefined;
  const mpn = offer.identity.mpn ?? inferredMpn;
  return {
    explicit: Boolean(size || color || mpn || offer.identity.sku || offer.identity.upc || offer.identity.gtin),
    size, color, sku: offer.identity.sku, upc: offer.identity.upc, gtin: offer.identity.gtin, mpn
  };
}

export function assessSovrnIdentity(source: SovrnSourceEvidence, offer: SovrnWireOffer): SovrnIdentityAssessment {
  if (source.store === "homedepot") return assessHomeDepotSovrnIdentity(source, offer);
  const offerName = offer.title ? normalizedName(offer.title) : "";
  const offerEvidence = offerVariant(offer, source);
  const variantClassification = classifySovrnVariant(source.variant, offerEvidence);
  const nameMatch = source.productNames.some(name => {
    const normalized = normalizedName(name);
    if (normalized.length < 8) return false;
    if (offerName.includes(normalized) || normalized.includes(offerName)) return true;
    // Reordering alone is supporting evidence only after independently extracted
    // variant fields match. No synonyms or semantic/fuzzy title inference is used.
    return variantClassification === "EXACT_VARIANT_MATCH" && reorderedTitleMatch(name, offer.title ?? "");
  });
  return {
    productMatchConfirmed: source.productIdConfirmed && nameMatch,
    variantClassification,
    sourceVariant: source.variant,
    offerVariant: offerEvidence
  };
}
