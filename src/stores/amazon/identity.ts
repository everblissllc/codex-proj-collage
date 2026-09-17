import { ProductError } from "../../types";
import { validatePublicUrl } from "../safe-url";
import { amazonAsinFromUrl, validAsin } from "./diagnostics";

export type AmazonSourceIdentityState = "SOURCE_CONFIRMED" | "SOURCE_CONFLICT" | "SOURCE_UNCONFIRMED";
export type AmazonResolvedIdentity = {
  asin: string;
  sourceIdentityState: AmazonSourceIdentityState;
  sourceIdentityAsin?: string;
  sourceIdentitySource?: "resolved-product-route" | "canonical" | "json-ld" | "add-to-cart";
};

function allowedAmazonHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "amazon.com" || lower.endsWith(".amazon.com");
}

function attribute(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return tag.match(new RegExp(`\\b${escaped}\\s*=\\s*(["'])(.*?)\\1`, "i"))?.[2];
}

function canonicalAsin(html: string, resolvedUrl: string): string | undefined {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']canonical["']/i.test(tag)) continue;
    const href = attribute(tag, "href");
    if (!href) continue;
    try {
      const asin = amazonAsinFromUrl(new URL(href, resolvedUrl).href);
      if (asin) return asin;
    } catch { /* An invalid optional canonical is not identity evidence. */ }
  }
  return undefined;
}

function identifierAsin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().toUpperCase();
  if (/^[A-Z0-9]{10}$/.test(trimmed)) return trimmed;
  const labeled = trimmed.match(/^ASIN\s*[:#-]?\s*([A-Z0-9]{10})$/)?.[1];
  if (validAsin(labeled)) return labeled;
  return amazonAsinFromUrl(value);
}

function jsonLdAsin(html: string): string | undefined {
  const candidates = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) { value.forEach(visit); return; }
    if (!value || typeof value !== "object") return;
    const record = value as Record<string, unknown>;
    const types = Array.isArray(record["@type"]) ? record["@type"] : [record["@type"]];
    if (types.some(type => typeof type === "string" && type.toLowerCase() === "product")) {
      for (const key of ["asin", "sku", "productID", "url", "@id"]) {
        const asin = identifierAsin(record[key]);
        if (asin) candidates.add(asin);
      }
    }
    if (record["@graph"]) visit(record["@graph"]);
  };
  for (const match of html.matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1])); } catch { /* Ignore malformed optional JSON-LD. */ }
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function addToCartAsin(html: string): string | undefined {
  const candidates = new Set<string>();
  for (const form of html.match(/<form\b[\s\S]*?<\/form>/gi) ?? []) {
    if (!/(?:id\s*=\s*["']add-to-cart-button["']|name\s*=\s*["']submit\.add-to-cart["'])/i.test(form)) continue;
    for (const input of form.match(/<input\b[^>]*>/gi) ?? []) {
      if (!/\b(?:id|name)\s*=\s*["']ASIN["']/i.test(input)) continue;
      const asin = identifierAsin(attribute(input, "value"));
      if (asin) candidates.add(asin);
    }
  }
  return candidates.size === 1 ? [...candidates][0] : undefined;
}

function sourceEvidence(html: string | undefined, resolvedUrl: string): Pick<AmazonResolvedIdentity, "sourceIdentityAsin" | "sourceIdentitySource"> {
  if (!html) return {};
  const canonical = canonicalAsin(html, resolvedUrl);
  if (canonical) return { sourceIdentityAsin: canonical, sourceIdentitySource: "canonical" };
  const structured = jsonLdAsin(html);
  if (structured) return { sourceIdentityAsin: structured, sourceIdentitySource: "json-ld" };
  const cart = addToCartAsin(html);
  return cart ? { sourceIdentityAsin: cart, sourceIdentitySource: "add-to-cart" } : {};
}

export function trustedAmazonAsin(inputUrl: string): string {
  const asin = amazonAsinFromUrl(inputUrl);
  if (!asin) throw new ProductError("MISSING_PRODUCT_ID", "extraction", "Original Amazon product URL does not contain a trusted ASIN");
  return asin;
}

export function resolveAmazonIdentity(inputUrl: string, resolvedUrl: string, html?: string): AmazonResolvedIdentity {
  const finalUrl = validatePublicUrl(resolvedUrl);
  if (!allowedAmazonHost(finalUrl.hostname)) throw new ProductError("UNSAFE_AMAZON_URL", "url", "Amazon redirect left the approved retailer domain");

  const submittedAsin = amazonAsinFromUrl(inputUrl);
  const resolvedAsin = amazonAsinFromUrl(finalUrl.href);
  const evidence = resolvedAsin
    ? { sourceIdentityAsin: resolvedAsin, sourceIdentitySource: "resolved-product-route" as const }
    : sourceEvidence(html, finalUrl.href);
  if (submittedAsin && evidence.sourceIdentityAsin && evidence.sourceIdentityAsin !== submittedAsin) {
    throw new ProductError("AMAZON_ASIN_MISMATCH", "extraction", "Amazon redirect identifies another product", "SOURCE_CONFLICT");
  }
  const asin = submittedAsin ?? evidence.sourceIdentityAsin;
  if (!asin) throw new ProductError("MISSING_PRODUCT_ID", "extraction", "Amazon destination does not contain a trusted ASIN");
  return {
    asin,
    sourceIdentityState: evidence.sourceIdentityAsin ? "SOURCE_CONFIRMED" : "SOURCE_UNCONFIRMED",
    ...evidence
  };
}
