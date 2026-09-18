import { readLimitedTextWithSize, resolveUrl } from "../resolve-url";
import { classifySovrnVariantMatch, type SovrnPilotCandidate, type SovrnPilotLookupResult, type SovrnVariantClassification, type SovrnVariantEvidence } from "./feasibility";
import { hostnameMatches, merchantMatchesStore, sovrnMerchantAdapters } from "./merchant-registry";
import { extractElfProduct } from "../screenshot/elf";
import { extractWalmartProduct } from "../walmart/extractor";
import type { SovrnStoreId } from "./types";

export type SovrnSourceIdentityClassification =
  | "EXACT_CONFIRMED"
  | "PRODUCT_CONFIRMED_VARIANT_AMBIGUOUS"
  | "PRODUCT_AMBIGUOUS"
  | "NO_SOURCE_IDENTITY";

type SafeProductIdentity = {
  name?: string;
  sku?: string;
  productId?: string;
  gtin?: string;
  mpn?: string;
  size?: string;
  color?: string;
};

export type SovrnSourceIdentitySummary = {
  store: SovrnStoreId;
  httpStatus?: number;
  hostname?: string;
  contentType?: string;
  responseByteLength?: number;
  redirectCount?: number;
  sourceProductId?: string;
  sourceProductIdPresent?: boolean;
  variantQuery: Record<string, string>;
  canonical?: { hostname: string; pathname: string; variantQuery: Record<string, string> };
  pageTitle?: string;
  jsonLdProducts: SafeProductIdentity[];
  matchedVariations: Array<{ variationId?: string; sku?: string; attributes: Record<string, string> }>;
  variantEvidence?: SovrnVariantEvidence;
  existingProduct?: {
    rawTitle: string;
    currentPrice: { value: number; formatted: string; currency: string };
    oldPrice?: { value: number; formatted: string; currency: string };
    imagePresent: boolean;
    imageHostname?: string;
    postUrlPreserved: boolean;
  };
  existingProductError?: string;
  errorCode?: string;
};

export type SovrnPilotIdentityAssessment = {
  productMatchConfirmed: boolean;
  variantClassification: SovrnVariantClassification;
  sourceVariantEvidence: SovrnVariantEvidence;
  sovrnVariantEvidence: SovrnVariantEvidence;
};

const decodeHtml = (value: string): string => value
  .replace(/&quot;|&#34;/gi, '"').replace(/&apos;|&#39;/gi, "'")
  .replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">");

function attributes(tag: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    output[match[1].toLowerCase()] = decodeHtml(match[2] ?? match[3] ?? "");
  }
  return output;
}

function clean(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = String(value).replace(/\s+/g, " ").trim();
  return result ? result.slice(0, 300) : undefined;
}

function productNodes(value: unknown, output: Record<string, unknown>[] = []): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    for (const child of value) productNodes(child, output);
    return output;
  }
  if (!value || typeof value !== "object") return output;
  const item = value as Record<string, unknown>;
  const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
  if (types.some(type => typeof type === "string" && type.toLowerCase() === "product")) output.push(item);
  for (const child of Object.values(item)) if (child && typeof child === "object") productNodes(child, output);
  return output;
}

function safeProduct(value: Record<string, unknown>): SafeProductIdentity {
  return {
    name: clean(value.name),
    sku: clean(value.sku),
    productId: clean(value.productID ?? value.productId),
    gtin: clean(value.gtin ?? value.gtin8 ?? value.gtin12 ?? value.gtin13 ?? value.gtin14),
    mpn: clean(value.mpn),
    size: clean(value.size),
    color: clean(value.color)
  };
}

function jsonLdProducts(html: string): SafeProductIdentity[] {
  const products: SafeProductIdentity[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const parsed: unknown = JSON.parse(decodeHtml(match[1]).trim());
      products.push(...productNodes(parsed).map(safeProduct));
    } catch { /* Invalid unrelated JSON-LD is not identity evidence. */ }
  }
  return products.slice(0, 10);
}

function canonicalSummary(html: string, base: URL, significant: readonly string[]): SovrnSourceIdentitySummary["canonical"] {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if (!attrs.rel?.split(/\s+/).some(value => value.toLowerCase() === "canonical") || !attrs.href) continue;
    try {
      const url = new URL(attrs.href, base);
      return { hostname: url.hostname, pathname: url.pathname, variantQuery: selectedQuery(url, significant) };
    } catch { return undefined; }
  }
  return undefined;
}

function selectedQuery(url: URL, significant: readonly string[]): Record<string, string> {
  const allowed = new Set(significant.map(value => value.toLowerCase()));
  const output: Record<string, string> = {};
  url.searchParams.forEach((value, key) => {
    if (allowed.has(key.toLowerCase()) || key.toLowerCase().startsWith("attribute_pa_")) output[key] = value;
  });
  return output;
}

function title(html: string): string | undefined {
  const og = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => attributes(match[0]))
    .find(attrs => (attrs.property ?? attrs.name)?.toLowerCase() === "og:title")?.content;
  if (og) return clean(og);
  const match = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  return match ? clean(decodeHtml(match[1]).replace(/<[^>]*>/g, "")) : undefined;
}

function matchedWooVariations(html: string, query: Record<string, string>): SovrnSourceIdentitySummary["matchedVariations"] {
  const expected = Object.entries(query).filter(([key]) => key.toLowerCase().startsWith("attribute_pa_"));
  if (!expected.length) return [];
  const output: SovrnSourceIdentitySummary["matchedVariations"] = [];
  for (const tag of html.matchAll(/<[^>]+data-product_variations\s*=\s*(?:"[^"]*"|'[^']*')[^>]*>/gi)) {
    const encoded = attributes(tag[0])["data-product_variations"];
    if (!encoded) continue;
    try {
      const variations = JSON.parse(encoded) as unknown;
      if (!Array.isArray(variations)) continue;
      for (const candidate of variations) {
        if (!candidate || typeof candidate !== "object") continue;
        const item = candidate as Record<string, unknown>;
        const rawAttributes = item.attributes;
        if (!rawAttributes || typeof rawAttributes !== "object" || Array.isArray(rawAttributes)) continue;
        const variationAttributes = Object.fromEntries(Object.entries(rawAttributes as Record<string, unknown>)
          .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
        if (!expected.every(([key, value]) => variationAttributes[key] === value)) continue;
        output.push({
          variationId: clean(item.variation_id ?? item.variationId),
          sku: clean(item.sku),
          attributes: variationAttributes
        });
      }
    } catch { /* Malformed variation state is not evidence. */ }
  }
  return output.slice(0, 10);
}

function sizeFromValue(value: string): string | undefined {
  const normalized = value.replace(/[_-]+/g, " ");
  const match = normalized.match(/(\d+(?:\.\d+)?)\s*(fl\s*oz|oz|ml)\b/i);
  return match ? `${match[1]} ${match[2].replace(/\s+/g, " ")}` : undefined;
}

function sourceVariantEvidence(
  store: SovrnStoreId,
  html: string,
  variantQuery: Record<string, string>,
  products: readonly SafeProductIdentity[],
  variations: SovrnSourceIdentitySummary["matchedVariations"]
): SovrnVariantEvidence {
  const selectedTargetSize = [...html.matchAll(/<[^>]+aria-label\s*=\s*(?:"([^"]+)"|'([^']+)')[^>]*>/gi)]
    .map(match => decodeHtml(match[1] ?? match[2] ?? ""))
    .map(label => label.match(/^Size,\s*(.+?),\s*selected$/i)?.[1])
    .find((value): value is string => Boolean(value));
  const structuredSize = html.match(/"dimensionsValue"\s*:\s*"([^"]+)"/i)?.[1]
    ?? html.match(/"product_size"\s*:\s*\[\s*"([^"]+)"/i)?.[1];
  const querySize = Object.entries(variantQuery).find(([key]) => /(?:^size$|attribute_pa_.*size)/i.test(key))?.[1];
  const variation = variations.length === 1 ? variations[0] : undefined;
  const size = selectedTargetSize ?? structuredSize ?? (querySize ? sizeFromValue(querySize) : undefined) ?? products.find(product => product.size)?.size;
  const shade = variantQuery.shade ?? variantQuery.color ?? products.find(product => product.color)?.color;
  const sku = variation?.sku ?? variantQuery.sku ?? products.find(product => product.sku)?.sku;
  const variantId = variation?.variationId ?? variantQuery.variant ?? variantQuery.skuid;
  const color = shade ?? products.find(product => product.color)?.color
    ?? clean(html.match(/"color"\s*:\s*"([^"]+)"/i)?.[1]);
  const mpn = products.find(product => product.mpn)?.mpn
    ?? clean(html.match(/"(?:model|modelNumber|mpn)"\s*:\s*"([^"]+)"/i)?.[1]);
  const explicit = Boolean(size || color || variantId || mpn);
  const variantSignals = /(?:shade|swatch|variation|variant-selector|product-options)/i.test(html);
  return {
    explicit,
    multiVariantFamily: !explicit && (store === "nordstrom" || variantSignals),
    size,
    shade,
    ...(color ? { color } : {}),
    variantId,
    sku,
    gtin: products.find(product => product.gtin)?.gtin,
    ...(mpn ? { mpn } : {})
  };
}

function sizeFromOfferName(name?: string): string | undefined {
  if (!name) return undefined;
  const matches = [...name.matchAll(/\b(\d+(?:\.\d+)?)\s*(fl\.?\s*oz\.?|oz\.?|ml)\b/gi)];
  const match = matches.at(-1);
  return match ? `${match[1]} ${match[2].replace(/\./g, "").replace(/\s+/g, " ")}` : undefined;
}

const normalizedProductName = (value: string): string => value.toLowerCase()
  .replace(/&(?:#8211|ndash|mdash);/g, " ")
  .replace(/[^a-z0-9]+/g, " ")
  .trim();

function sameProduct(source: SovrnSourceIdentitySummary, offerName?: string): boolean {
  if (!source.sourceProductIdPresent || !offerName) return false;
  const offer = normalizedProductName(offerName);
  const names = source.jsonLdProducts.map(product => product.name).filter((value): value is string => Boolean(value));
  if (!names.length && source.pageTitle) names.push(source.pageTitle.split(/\s+[|–—]\s+/)[0]);
  return names.some(name => {
    const normalized = normalizedProductName(name);
    return normalized.length >= 8 && (offer.includes(normalized) || normalized.includes(offer));
  });
}

export function assessSovrnPilotIdentity(
  result: SovrnPilotLookupResult,
  source: SovrnSourceIdentitySummary | undefined
): SovrnPilotIdentityAssessment {
  const unavailable: SovrnPilotIdentityAssessment = {
    productMatchConfirmed: false,
    variantClassification: "NO_VARIANT_CONFLICT",
    sourceVariantEvidence: { explicit: false },
    sovrnVariantEvidence: { explicit: false }
  };
  if (!source || source.store !== result.store || source.errorCode || !source.httpStatus || source.httpStatus < 200 || source.httpStatus >= 300) {
    return unavailable;
  }
  const sameRetailerOffers = result.structure?.offers.filter(offer => merchantMatchesStore(result.store, { name: offer.merchant.name })) ?? [];
  if (sameRetailerOffers.length !== 1) return { ...unavailable, sourceVariantEvidence: source.variantEvidence ?? { explicit: false } };
  const offer = sameRetailerOffers[0];
  const sourceEvidence = source.variantEvidence ?? { explicit: false };
  const size = sizeFromOfferName(offer.name);
  const matchingShade = sourceEvidence.shade && offer.name && normalizedProductName(offer.name).includes(normalizedProductName(sourceEvidence.shade))
    ? sourceEvidence.shade
    : undefined;
  const matchingColor = sourceEvidence.color && offer.name && normalizedProductName(offer.name).includes(normalizedProductName(sourceEvidence.color))
    ? sourceEvidence.color
    : undefined;
  const matchingMpn = sourceEvidence.mpn && offer.name && normalizedProductName(offer.name).includes(normalizedProductName(sourceEvidence.mpn))
    ? sourceEvidence.mpn
    : undefined;
  const offerName = offer.name ? normalizedProductName(offer.name) : "";
  const sourceName = source.jsonLdProducts.map(product => product.name).filter((value): value is string => Boolean(value))
    .map(normalizedProductName).sort((left, right) => right.length - left.length).find(name => offerName.includes(name));
  const variantSuffix = sourceEvidence.multiVariantFamily && sourceName
    ? offerName.split(sourceName, 2)[1]?.replace(/\b\d+(?:\.\d+)?\s*(?:fl\s*)?oz\b|\b\d+(?:\.\d+)?\s*ml\b|\bin\s+jar\b/g, " ").trim()
    : undefined;
  const offerEvidence: SovrnVariantEvidence = {
    explicit: Boolean(size || matchingShade || matchingColor || matchingMpn || variantSuffix),
    size,
    shade: matchingShade ?? variantSuffix,
    color: matchingColor,
    mpn: matchingMpn,
    container: offer.name && /\bin\s+jar\b/i.test(offer.name) ? "jar" : undefined
  };
  return {
    productMatchConfirmed: sameProduct(source, offer.name),
    variantClassification: classifySovrnVariantMatch(sourceEvidence, offerEvidence),
    sourceVariantEvidence: sourceEvidence,
    sovrnVariantEvidence: offerEvidence
  };
}

export function inspectSovrnSourceIdentity(input: {
  store: SovrnStoreId;
  sourceUrl: string;
  resolvedUrl: string;
  httpStatus: number;
  contentType?: string;
  responseByteLength: number;
  redirectCount: number;
  html: string;
}): SovrnSourceIdentitySummary {
  const source = new URL(input.sourceUrl);
  const resolved = new URL(input.resolvedUrl);
  const adapter = sovrnMerchantAdapters[input.store];
  if (!adapter.domains.some(domain => hostnameMatches(resolved.hostname, domain))) throw new Error("SOURCE_HOST_MISMATCH");
  const sourceProductId = adapter.productIdentity(source);
  const variantQuery = selectedQuery(source, adapter.productSignificantParams);
  const products = jsonLdProducts(input.html);
  const variations = matchedWooVariations(input.html, variantQuery);
  let existingProduct: SovrnSourceIdentitySummary["existingProduct"];
  let existingProductError: string | undefined;
  if (input.store === "elf" || input.store === "walmart") {
    try {
      const product = input.store === "elf"
        ? extractElfProduct(input.html, input.sourceUrl, input.resolvedUrl)
        : extractWalmartProduct(input.html, input.sourceUrl, input.resolvedUrl);
      let imageHostname: string | undefined;
      try { imageHostname = new URL(product.imageUrl).hostname; } catch { /* Extractor already validates this URL. */ }
      existingProduct = {
        rawTitle: product.rawTitle,
        currentPrice: product.currentPrice,
        oldPrice: product.oldPrice,
        imagePresent: Boolean(product.imageUrl),
        imageHostname,
        postUrlPreserved: product.postUrl === input.sourceUrl
      };
    } catch (error) {
      existingProductError = error && typeof error === "object" && "code" in error && typeof error.code === "string"
        ? error.code
        : "ELF_EXTRACTION_FAILED";
    }
  }
  return {
    store: input.store,
    httpStatus: input.httpStatus,
    hostname: resolved.hostname,
    contentType: input.contentType,
    responseByteLength: input.responseByteLength,
    redirectCount: input.redirectCount,
    sourceProductId,
    sourceProductIdPresent: Boolean(sourceProductId && input.html.toLowerCase().includes(sourceProductId.toLowerCase())),
    variantQuery,
    canonical: canonicalSummary(input.html, resolved, adapter.productSignificantParams),
    pageTitle: title(input.html),
    jsonLdProducts: products,
    matchedVariations: variations,
    variantEvidence: sourceVariantEvidence(input.store, input.html, variantQuery, products, variations),
    existingProduct,
    existingProductError
  };
}

export async function fetchSovrnSourceIdentities(candidates: readonly SovrnPilotCandidate[]): Promise<SovrnSourceIdentitySummary[]> {
  const output: SovrnSourceIdentitySummary[] = [];
  for (const candidate of candidates.filter(candidate => candidate.store !== "bubble")) {
    try {
      const page = await resolveUrl(candidate.url);
      const contentType = page.response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      const httpStatus = page.response.status;
      const body = await readLimitedTextWithSize(page.response);
      output.push(inspectSovrnSourceIdentity({
        store: candidate.store,
        sourceUrl: candidate.url,
        resolvedUrl: page.resolvedUrl,
        httpStatus,
        contentType,
        responseByteLength: body.byteLength,
        redirectCount: page.redirectCount,
        html: body.text
      }));
    } catch (error) {
      output.push({
        store: candidate.store,
        variantQuery: {},
        jsonLdProducts: [],
        matchedVariations: [],
        errorCode: error && typeof error === "object" && "code" in error && typeof error.code === "string"
          ? error.code
          : error instanceof Error ? error.message.slice(0, 80) : "SOURCE_IDENTITY_FAILED"
      });
    }
  }
  return output;
}
