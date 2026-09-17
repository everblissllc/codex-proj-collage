import { readLimitedTextWithSize, resolveUrl } from "../resolve-url";
import { hostnameMatches, sovrnMerchantAdapters } from "./merchant-registry";
import type { SovrnPilotCandidate } from "./feasibility";
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
  errorCode?: string;
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
  return {
    store: input.store,
    httpStatus: input.httpStatus,
    hostname: resolved.hostname,
    contentType: input.contentType,
    responseByteLength: input.responseByteLength,
    redirectCount: input.redirectCount,
    sourceProductId,
    sourceProductIdPresent: Boolean(sourceProductId && input.html.toLowerCase().includes(sourceProductId.toLowerCase())),
    variantQuery: selectedQuery(source, adapter.productSignificantParams),
    canonical: canonicalSummary(input.html, resolved, adapter.productSignificantParams),
    pageTitle: title(input.html),
    jsonLdProducts: jsonLdProducts(input.html),
    matchedVariations: matchedWooVariations(input.html, selectedQuery(source, adapter.productSignificantParams))
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
