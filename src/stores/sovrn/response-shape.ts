import { hostnameMatches } from "./merchant-registry";
import type { SovrnApprovedMerchantFinding, SovrnPilotOfferSummary, SovrnPilotPriceSummary, SovrnStructuralOffer, SovrnStructuralSummary } from "./types";

type Primitive = string | number | boolean;
type Leaf = { path: string; key: string; value: Primitive; type: string };
const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const typeOf = (value: unknown): string => Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
const keyLike = (key: string, words: readonly string[]): boolean => words.some(word => key.toLowerCase().includes(word));

function leaves(value: unknown, prefix = "", depth = 0): Leaf[] {
  if (depth > 6) return [];
  if (Array.isArray(value)) {
    return value.slice(0, 100).flatMap((child, index) => {
      const path = `${prefix}[${index}]`;
      if (["string", "number", "boolean"].includes(typeof child)) {
        return [{ path, key: prefix.split(".").at(-1) ?? "item", value: child as Primitive, type: typeof child }];
      }
      return leaves(child, path, depth + 1);
    });
  }
  const item = record(value);
  if (!item) return [];
  const output: Leaf[] = [];
  for (const [key, child] of Object.entries(item)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (["string", "number", "boolean"].includes(typeof child)) output.push({ path, key, value: child as Primitive, type: typeof child });
    else if (Array.isArray(child) || record(child)) output.push(...leaves(child, path, depth + 1));
  }
  return output;
}

function arrays(value: unknown, prefix = "", depth = 0): Array<{ path: string; values: unknown[] }> {
  if (depth > 5) return [];
  const item = record(value);
  if (!item) return [];
  const output: Array<{ path: string; values: unknown[] }> = [];
  for (const [key, child] of Object.entries(item)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (Array.isArray(child)) {
      if (child.some(element => Boolean(record(element)))) output.push({ path, values: child });
      for (const element of child.slice(0, 3)) output.push(...arrays(element, `${path}[]`, depth + 1));
    } else if (record(child)) output.push(...arrays(child, path, depth + 1));
  }
  return output;
}

function resultArray(value: unknown): { path?: string; values: unknown[] } {
  if (Array.isArray(value)) return { path: "$", values: value };
  const candidates = arrays(value);
  const named = candidates.find(candidate => /(?:^|\.)(results|products|offers|items)$/i.test(candidate.path));
  return named ?? candidates[0] ?? { values: [] };
}

const categoryWords: Record<string, readonly string[]> = {
  merchant: ["merchant", "retailer", "domain", "store"],
  productIdentity: ["barcode", "gtin", "upc", "ean", "sku", "productid", "product_id", "plainlink", "producturl", "product_url", "url", "link"],
  title: ["title", "productname", "product_name"],
  image: ["image", "thumbnail"],
  currentPrice: ["saleprice", "sale_price", "currentprice", "current_price", "price"],
  referencePrice: ["regularprice", "retailprice", "originalprice", "listprice", "referenceprice", "wasprice", "regular_price", "retail_price", "original_price", "list_price", "reference_price", "was_price"],
  stock: ["stock", "availability", "available"],
  currency: ["currency", "currencycode", "currency_code"]
};

type FieldDescription = { path: string; type: string; value?: Primitive; https?: boolean; hostname?: string; pathShape?: string };
function describeField(leaf: Leaf, category: string): FieldDescription {
  if ((category === "merchant" || category === "productIdentity") && typeof leaf.value === "string") {
    try {
      const url = new URL(leaf.value);
      return { path: leaf.path, type: leaf.type, https: url.protocol === "https:", hostname: url.hostname, pathShape: url.pathname.replace(/[A-Za-z0-9]{6,}/g, ":id") };
    } catch { /* Non-URL merchant names and product IDs are safe primitive evidence. */ }
  }
  if (category !== "image") return { path: leaf.path, type: leaf.type, value: leaf.value };
  if (typeof leaf.value !== "string") return { path: leaf.path, type: leaf.type };
  try { const url = new URL(leaf.value); return { path: leaf.path, type: leaf.type, https: url.protocol === "https:", hostname: url.hostname }; }
  catch { return { path: leaf.path, type: leaf.type, https: false }; }
}

function candidatesFor(all: Leaf[], category: string): FieldDescription[] {
  return all.filter(leaf => keyLike(leaf.key.replace(/[^a-z0-9_]/gi, ""), categoryWords[category]))
    .filter(leaf => category !== "currentPrice" || !keyLike(leaf.key, categoryWords.referencePrice))
    .filter(leaf => category !== "productIdentity" || !keyLike(leaf.key, ["affiliate", "tracking", "image", "thumbnail"]))
    .map(leaf => describeField(leaf, category));
}

function describeOffer(value: unknown, arrayPath: string): SovrnStructuralOffer {
  const item = record(value) ?? {};
  const keys = Object.keys(item).sort();
  const fieldTypes = Object.fromEntries(keys.map(key => [key, typeOf(item[key])]));
  const all = leaves(item, `${arrayPath}[]`);
  const candidateFields = Object.fromEntries(Object.keys(categoryWords).map(category => [category, candidatesFor(all, category)]));
  const merchantIdentityFields = Object.fromEntries(candidateFields.merchant
    .filter(entry => entry.value !== undefined).map(entry => [entry.path, entry.value!])) as Record<string, Primitive>;
  return {
    keys, fieldTypes, merchantIdentityFields, candidateFields,
    presence: {
      titleLike: candidateFields.title.length > 0,
      imageLike: candidateFields.image.length > 0,
      priceLike: candidateFields.currentPrice.length > 0,
      stockLike: candidateFields.stock.length > 0,
      referencePriceLike: candidateFields.referencePrice.length > 0,
      productIdentityLike: candidateFields.productIdentity.length > 0
    }
  };
}

export function describeSovrnResponse(value: unknown): SovrnStructuralSummary {
  const root = record(value);
  const selected = resultArray(value);
  const arrayPath = selected.path ?? "$";
  return {
    topLevelType: typeOf(value), topLevelKeys: root ? Object.keys(root).sort() : [],
    resultArrayPath: selected.path, resultCount: selected.values.length,
    offers: selected.values.slice(0, 20).map(offer => describeOffer(offer, arrayPath))
  };
}

function publicImageSummary(value: unknown): { present: boolean; https?: boolean; hostname?: string } {
  if (typeof value !== "string" || !value.trim()) return { present: false };
  try {
    const url = new URL(value);
    return { present: true, https: url.protocol === "https:", hostname: url.hostname };
  } catch { return { present: true, https: false }; }
}

function exactPilotOffer(value: unknown, arrayPath: string): SovrnPilotOfferSummary {
  const item = record(value) ?? {};
  const merchant = record(item.merchant) ?? {};
  const exactFields: Array<[string, unknown]> = [
    ["merchant.name", merchant.name], ["merchant.id", merchant.id], ["name", item.name], ["id", item.id],
    ["salePrice", item.salePrice], ["retailPrice", item.retailPrice], ["currency", item.currency],
    ["discountRate", item.discountRate], ["affiliatable", item.affiliatable], ["deeplink", item.deeplink],
    ["image", item.image], ["thumbnail", item.thumbnail]
  ];
  const all = leaves(item, `${arrayPath}[]`);
  const stockFields = all.filter(leaf => keyLike(leaf.key, ["stock", "availability", "available"]))
    .map(({ path, type, value: fieldValue }) => ({ path, type, value: fieldValue }));
  const strongerIdentityFields = all.filter(leaf => /^(barcode|gtin|upc|ean|sku|mpn|product_?id)$/i.test(leaf.key))
    .map(({ path, type, value: fieldValue }) => ({ path, type, value: fieldValue }));
  return {
    merchant: {
      name: typeof merchant.name === "string" ? merchant.name : undefined,
      id: typeof merchant.id === "string" || typeof merchant.id === "number" ? merchant.id : undefined
    },
    name: typeof item.name === "string" ? item.name : undefined,
    id: typeof item.id === "string" || typeof item.id === "number" ? item.id : undefined,
    salePrice: typeof item.salePrice === "number" ? item.salePrice : undefined,
    retailPrice: typeof item.retailPrice === "number" ? item.retailPrice : undefined,
    currency: typeof item.currency === "string" ? item.currency : undefined,
    discountRate: typeof item.discountRate === "number" ? item.discountRate : undefined,
    affiliatable: typeof item.affiliatable === "boolean" ? item.affiliatable : undefined,
    deeplinkPresent: typeof item.deeplink === "string" && item.deeplink.length > 0,
    image: publicImageSummary(item.image),
    thumbnail: publicImageSummary(item.thumbnail),
    fieldTypes: Object.fromEntries(exactFields.map(([path, fieldValue]) => [path, typeOf(fieldValue)])),
    stockFields,
    strongerIdentityFields
  };
}

export function describeSovrnPriceResponse(value: unknown): SovrnPilotPriceSummary {
  const root = record(value);
  const selected = resultArray(value);
  return {
    topLevelType: typeOf(value),
    topLevelKeys: root ? Object.keys(root).sort() : [],
    resultCount: selected.values.length,
    offers: selected.values.slice(0, 20).map(offer => exactPilotOffer(offer, selected.path ?? "$"))
  };
}

function stringDomain(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  try { return new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname; }
  catch { return /^[a-z0-9.-]+$/.test(trimmed) && trimmed.includes(".") ? trimmed : undefined; }
}

export function inspectApprovedMerchants(value: unknown, domains: readonly string[]): SovrnApprovedMerchantFinding[] {
  const selected = resultArray(value);
  const entries = selected.values.map(entry => leaves(entry, `${selected.path ?? "$"}[]`));
  return domains.map(domain => {
    const matching = entries.find(entry => entry.some(leaf => {
      if (typeof leaf.value !== "string") return false;
      const candidate = stringDomain(leaf.value);
      return Boolean(candidate && hostnameMatches(candidate, domain));
    }));
    if (!matching) return { domain, found: false, approved: false, statusFields: [], identityFields: [] };
    const identityFields = matching.filter(leaf => keyLike(leaf.key, ["merchant", "group", "domain", "name"]))
      .map(leaf => ({ path: leaf.path, value: typeof leaf.value === "string" ? (stringDomain(leaf.value) ?? leaf.value) : leaf.value }));
    const statusFields = matching.filter(leaf => keyLike(leaf.key, ["status", "approved", "available", "program", "geo", "country"]))
      .map(leaf => ({ path: leaf.path, value: leaf.value }));
    const group = matching.find(leaf => /(?:merchant|group).*id|id.*(?:merchant|group)/i.test(leaf.key) && (typeof leaf.value === "string" || typeof leaf.value === "number"));
    const groupId = group && (typeof group.value === "string" || typeof group.value === "number") ? group.value : undefined;
    return { domain, found: true, approved: true, groupId, statusFields, identityFields };
  });
}
