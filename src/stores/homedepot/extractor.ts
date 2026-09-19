import { ProductError, type HomeDepotProductMetadata, type Price, type ProductData } from "../../types";
import { validatePublicUrl } from "../safe-url";

type JsonRecord = Record<string, unknown>;

export type HomeDepotProductEvidence = HomeDepotProductMetadata & {
  configuration: string[];
  canonicalProductUrl: string;
};

const record = (value: unknown): JsonRecord | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : undefined;
const text = (value: unknown): string | undefined => {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const result = String(value).replace(/&amp;/gi, "&").replace(/&quot;|&#34;/gi, '"')
    .replace(/&apos;|&#39;/gi, "'").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/\s+/g, " ").trim();
  return result || undefined;
};
const finite = (value: unknown): number | undefined => {
  const candidate = typeof value === "number" ? value : typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value.trim()) ? Number(value) : NaN;
  return Number.isFinite(candidate) && candidate > 0 ? candidate : undefined;
};
const homeDepotHost = (hostname: string): boolean => hostname === "homedepot.com" || hostname.endsWith(".homedepot.com");

export function homeDepotProductId(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (!homeDepotHost(url.hostname.toLowerCase())) return undefined;
    return url.pathname.match(/\/p\/(?:[^/]+\/)?(\d+)(?:\/)?$/i)?.[1];
  } catch { return undefined; }
}

function attributes(tag: string): Record<string, string> {
  const output: Record<string, string> = {};
  for (const match of tag.matchAll(/([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    output[match[1].toLowerCase()] = text(match[2] ?? match[3]) ?? "";
  }
  return output;
}

function canonicalUrl(html: string, resolvedUrl: string): string | undefined {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const attrs = attributes(match[0]);
    if (!attrs.rel?.split(/\s+/).some(value => value.toLowerCase() === "canonical") || !attrs.href) continue;
    try {
      const url = validatePublicUrl(new URL(attrs.href, resolvedUrl).href);
      return homeDepotHost(url.hostname.toLowerCase()) ? url.href : undefined;
    } catch { return undefined; }
  }
  return undefined;
}

function productNodes(value: unknown, output: JsonRecord[] = []): JsonRecord[] {
  if (Array.isArray(value)) { value.forEach(item => productNodes(item, output)); return output; }
  const item = record(value);
  if (!item) return output;
  const types = Array.isArray(item["@type"]) ? item["@type"] : [item["@type"]];
  if (types.some(type => typeof type === "string" && type.toLowerCase() === "product")) output.push(item);
  if (item["@graph"]) productNodes(item["@graph"], output);
  return output;
}

function jsonLdProducts(html: string): JsonRecord[] {
  const output: JsonRecord[] = [];
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { productNodes(JSON.parse(match[1]), output); } catch { /* Unrelated malformed JSON-LD is ignored. */ }
  }
  return output.slice(0, 20);
}

function productUrlIdentity(product: JsonRecord, resolvedUrl: string): string | undefined {
  const value = text(product.url);
  if (!value) return undefined;
  try { return homeDepotProductId(new URL(value, resolvedUrl).href); } catch { return undefined; }
}

function productIdentity(product: JsonRecord, resolvedUrl: string): string | undefined {
  const direct = text(product.productID ?? product.productId ?? product.sku);
  if (direct && /^\d+$/.test(direct)) return direct;
  return productUrlIdentity(product, resolvedUrl);
}

function offersFor(product: JsonRecord): JsonRecord[] {
  const value = product.offers;
  if (Array.isArray(value)) return value.map(record).filter((item): item is JsonRecord => Boolean(item));
  const item = record(value);
  return item ? [item] : [];
}

function imageUrl(product: JsonRecord): string | undefined {
  const value = Array.isArray(product.image) ? product.image[0] : product.image;
  const candidate = text(record(value)?.url ?? value);
  if (!candidate) return undefined;
  try {
    const url = validatePublicUrl(candidate);
    return url.protocol === "https:" ? url.href : undefined;
  } catch { return undefined; }
}

function money(value: number, currency: string): Price {
  return { value, currency, formatted: new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value) };
}

function referencePrice(offer: JsonRecord, current: number): number | undefined {
  const direct = finite(offer.wasPrice ?? offer.listPrice ?? offer.originalPrice);
  if (direct && direct > current) return direct;
  const specifications = Array.isArray(offer.priceSpecification) ? offer.priceSpecification : [offer.priceSpecification];
  for (const value of specifications) {
    const specification = record(value);
    const kind = text(specification?.priceType ?? specification?.name)?.toLowerCase();
    if (!kind || !/(?:list|was|regular|original|strike|msrp)/.test(kind)) continue;
    const candidate = finite(specification?.price ?? specification?.value);
    if (candidate && candidate > current) return candidate;
  }
  return undefined;
}

function configuration(product: JsonRecord): string[] {
  const values = [text(product.color), text(product.size), text(product.material)].filter((value): value is string => Boolean(value));
  const additional = Array.isArray(product.additionalProperty) ? product.additionalProperty : [];
  for (const value of additional) {
    const property = record(value);
    const name = text(property?.name);
    const propertyValue = text(property?.value);
    if (name && propertyValue && /(?:color|dimension|width|height|depth|gauge|configuration)/i.test(name)) values.push(`${name}: ${propertyValue}`);
  }
  return [...new Set(values)];
}

function brandName(product: JsonRecord): string | undefined {
  return text(record(product.brand)?.name ?? product.brand);
}

function propertyEntries(product: JsonRecord): Array<{ name: string; value: string }> {
  const additional = Array.isArray(product.additionalProperty) ? product.additionalProperty : [];
  return additional.flatMap(value => {
    const property = record(value);
    const name = text(property?.name);
    const propertyValue = text(property?.value);
    return name && propertyValue ? [{ name, value: propertyValue }] : [];
  });
}

function inches(value: string | undefined): number | undefined {
  const match = value?.match(/(\d+(?:\.\d+)?)\s*(?:in\.?|inch(?:es)?)/i);
  return match ? Number(match[1]) : undefined;
}

function selectedConfiguration(product: JsonRecord): Pick<HomeDepotProductEvidence, "dimensions" | "construction" | "mounting" | "packCount"> {
  const entries = propertyEntries(product);
  const property = (pattern: RegExp): string | undefined => entries.find(item => pattern.test(item.name))?.value;
  const width = inches(property(/^width$/i));
  const height = inches(property(/^height$/i));
  const depth = inches(property(/^depth$/i));
  const material = text(product.material ?? property(/material|construction/i));
  const gaugeText = [material, property(/gauge/i)].filter(Boolean).join(" ");
  const gaugeMatch = gaugeText.match(/(\d+(?:\.\d+)?)\s*[- ]?gauge/i);
  const mounting = text(product.mountingType ?? property(/mounting|installation|configuration/i));
  const packValue = property(/pack(?:age)?\s*(?:count|quantity)|number\s+in\s+pack/i);
  const packMatch = packValue?.match(/^\s*(\d+)\s*$/);
  return {
    dimensions: width !== undefined && height !== undefined && depth !== undefined
      ? { width, height, depth, unit: "in" }
      : undefined,
    construction: material || gaugeMatch ? { gauge: gaugeMatch ? Number(gaugeMatch[1]) : undefined, material } : undefined,
    mounting,
    packCount: packMatch ? Number(packMatch[1]) : undefined
  };
}

function selectedProduct(html: string, resolvedUrl: string): { product: JsonRecord; productId: string; canonical: string } {
  const productId = homeDepotProductId(resolvedUrl);
  if (!productId) throw new ProductError("HOMEDEPOT_PRODUCT_MISMATCH", "extraction", "Home Depot URL product identity is unavailable");
  const canonical = canonicalUrl(html, resolvedUrl);
  if (!canonical || homeDepotProductId(canonical) !== productId) {
    throw new ProductError("HOMEDEPOT_PRODUCT_MISMATCH", "extraction", "Home Depot canonical product identity does not match the URL");
  }
  const matches = jsonLdProducts(html).filter(product => productIdentity(product, resolvedUrl) === productId);
  if (matches.length !== 1) {
    throw new ProductError("HOMEDEPOT_PRODUCT_MISMATCH", "extraction", "Home Depot selected product record is unavailable or ambiguous");
  }
  return { product: matches[0], productId, canonical };
}

function productEvidence(product: JsonRecord, productId: string, canonical: string): HomeDepotProductEvidence {
  const model = text(product.mpn ?? product.model);
  if (!model) throw new ProductError("HOMEDEPOT_PRODUCT_MISMATCH", "extraction", "Home Depot model identity is unavailable");
  return {
    productId,
    model,
    brand: brandName(product),
    productFamily: text(product.category),
    color: text(product.color),
    ...selectedConfiguration(product),
    configuration: configuration(product),
    canonicalProductUrl: canonical
  };
}

export function inspectHomeDepotProduct(html: string, resolvedUrl: string): HomeDepotProductEvidence {
  const { product, productId, canonical } = selectedProduct(html, resolvedUrl);
  return productEvidence(product, productId, canonical);
}

export function extractHomeDepotProduct(html: string, inputUrl: string, resolvedUrl: string): ProductData {
  const { product, productId, canonical } = selectedProduct(html, resolvedUrl);
  const identity = productEvidence(product, productId, canonical);
  const title = text(product.name);
  const image = imageUrl(product);
  if (!title) throw new ProductError("MISSING_TITLE", "extraction", "Home Depot title unavailable");
  if (!image) throw new ProductError("MISSING_IMAGE", "extraction", "Home Depot product image unavailable");
  const offers = offersFor(product);
  const priced = offers.flatMap(offer => {
    const price = finite(offer.price ?? record(offer.priceSpecification)?.price);
    const currency = text(offer.priceCurrency ?? record(offer.priceSpecification)?.priceCurrency);
    return price && currency ? [{ offer, price, currency }] : [];
  });
  const priceKeys = new Set(priced.map(item => `${item.currency}:${item.price}`));
  if (priceKeys.size !== 1 || !priced.length) {
    throw new ProductError("MISSING_PRICE", "extraction", "Home Depot selected-product price is unavailable or ambiguous");
  }
  const selected = priced[0];
  if (selected.currency !== "USD") throw new ProductError("MISSING_PRICE", "extraction", "Home Depot selected-product currency is unsupported");
  const currentPrice = money(selected.price, selected.currency);
  const reference = referencePrice(selected.offer, selected.price);
  return {
    store: "homedepot", inputUrl, postUrl: inputUrl, resolvedUrl, canonicalProductUrl: canonical,
    rawTitle: title, imageUrl: image, currentPrice,
    oldPrice: reference ? money(reference, selected.currency) : undefined,
    homeDepot: {
      productId: identity.productId,
      model: identity.model,
      brand: identity.brand,
      productFamily: identity.productFamily,
      color: identity.color,
      dimensions: identity.dimensions,
      construction: identity.construction,
      mounting: identity.mounting,
      packCount: identity.packCount
    }
  };
}
