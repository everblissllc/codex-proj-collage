import { SovrnClient } from "../src/stores/sovrn/client";
import { merchantMatchesStore } from "../src/stores/sovrn/merchant-registry";
import { resolveUrl } from "../src/stores/resolve-url";

const PRODUCT_URL = "https://www.homedepot.com/p/Husky-Ready-to-Assemble-24-Gauge-Steel-Wall-Mounted-Garage-Cabinet-in-Black-28-in-W-x-29-7-in-H-x-12-in-D-G2802W-US/206288225";
const SOURCE_CURRENT_CENTS = 13_410;
const SOURCE_REFERENCE_CENTS = 14_900;
const requiredKeys = ["SOVRN_SECRET_KEY", "SOVRN_SITE_API_KEY", "SOVRN_MARKET"] as const;
type WireOffer = Record<string, unknown> & { merchant?: { name?: unknown; id?: unknown } };

function responseOffers(value: unknown): WireOffer[] {
  if (Array.isArray(value)) return value.filter((item): item is WireOffer => Boolean(item) && typeof item === "object");
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  for (const key of ["results", "offers", "products", "items"]) {
    if (Array.isArray(record[key])) return (record[key] as unknown[]).filter((item): item is WireOffer => Boolean(item) && typeof item === "object");
  }
  return [];
}

const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const cents = (value: unknown): number | undefined => {
  const number = finite(value);
  if (number === undefined || number <= 0) return undefined;
  const result = Math.round(number * 100);
  return Math.abs(number * 100 - result) < 0.000_001 ? result : undefined;
};
const normalized = (value: string): string => value.toLowerCase().replace(/[‐‑‒–—]/g, "-").replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim();

type IdentityClassification = "EXACT_VARIANT_MATCH" | "NO_VARIANT_CONFLICT" | "VARIANT_CONFLICT" | "VARIANT_AMBIGUOUS_HIGH_RISK" | "SOURCE_IDENTITY_UNAVAILABLE";
function identity(offer: WireOffer): { classification: IdentityClassification; evidence: Record<string, boolean>; model?: string } {
  const title = text(offer.name);
  if (!title) return { classification: "SOURCE_IDENTITY_UNAVAILABLE", evidence: {} };
  const value = normalized(title);
  const wireModel = text(offer.mpn ?? offer.model ?? offer.modelNumber);
  const model = wireModel ?? title.match(/\bG2802W-US\b/i)?.[0];
  const evidence = {
    brand: /\bhusky\b/.test(value),
    model: normalized(model ?? "") === "g2802w us",
    black: /\bblack\b/.test(value),
    width28: /\b28(?:\.0+)?\s*(?:in|inch|inches)\b/.test(value),
    height29_7: /\b29\.7\s*(?:in|inch|inches)\b/.test(value),
    depth12: /\b12(?:\.0+)?\s*(?:in|inch|inches)\b/.test(value),
    wallMounted: /\bwall\s+mounted\b/.test(value),
    gauge24: /\b24\s+gauge\b/.test(value),
    cabinet: /\bcabinet\b/.test(value)
  };
  const conflictingModel = Boolean(wireModel && !evidence.model);
  const conflictingColor = /\b(?:white|red|blue|gray|grey|silver)\b/.test(value) && !evidence.black;
  const conflictingDimensions = /\b(?:width|wide|w)\b/.test(value) && /\b\d+(?:\.\d+)?\s*(?:in|inch|inches)\b/.test(value) && !evidence.width28;
  if (conflictingModel || conflictingColor || conflictingDimensions) return { classification: "VARIANT_CONFLICT", evidence, model };
  if (Object.values(evidence).every(Boolean)) return { classification: "EXACT_VARIANT_MATCH", evidence, model };
  if (evidence.brand && evidence.model && evidence.cabinet && !conflictingColor && !conflictingDimensions) {
    return { classification: "NO_VARIANT_CONFLICT", evidence, model };
  }
  return { classification: "VARIANT_AMBIGUOUS_HIGH_RISK", evidence, model };
}

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.ok || Number(response.headers.get("content-length")) > maxBytes) throw new Error("IMAGE_INVALID");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("IMAGE_INVALID");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error("IMAGE_INVALID"); }
    chunks.push(value);
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.byteLength; }
  return output;
}

function signature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/png") return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return mimeType === "image/webp" && bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
}

async function imageResult(value: unknown, classification: IdentityClassification): Promise<Record<string, unknown>> {
  if (typeof value !== "string") return { valid: false, sameProductEvidence: "UNCONFIRMED", errorCode: "IMAGE_MISSING" };
  try {
    const page = await resolveUrl(value, undefined, "image/webp,image/png,image/jpeg");
    const url = new URL(page.resolvedUrl);
    const mimeType = page.response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) throw new Error("IMAGE_TYPE_INVALID");
    const bytes = await readBoundedBytes(page.response, 6_000_000);
    const valid = signature(bytes, mimeType);
    return {
      valid, hostname: url.hostname, mimeType,
      sameProductEvidence: valid && ["EXACT_VARIANT_MATCH", "NO_VARIANT_CONFLICT"].includes(classification)
        ? "IDENTITY_BOUND_SAME_RETAILER_IMAGE" : "UNCONFIRMED"
    };
  } catch { return { valid: false, sameProductEvidence: "UNCONFIRMED", errorCode: "IMAGE_VALIDATION_FAILED" }; }
}

function referenceParity(sovrnReferenceCents?: number): string {
  if (sovrnReferenceCents === undefined) return "HOME_DEPOT_ONLY";
  return sovrnReferenceCents === SOURCE_REFERENCE_CENTS ? "EXACT" : "DIFFERENT";
}

async function main(): Promise<void> {
  const missingKeys = requiredKeys.filter(key => !process.env[key]);
  if (missingKeys.length) throw new Error(`SOVRN_CONFIG_MISSING:${missingKeys.join(",")}`);
  if (process.env.SOVRN_MARKET !== "usd_en") throw new Error("SOVRN_MARKET_INVALID");
  const client = new SovrnClient({
    secretKey: process.env.SOVRN_SECRET_KEY!, siteApiKey: process.env.SOVRN_SITE_API_KEY!, market: "usd_en"
  });
  // This is the only live Price Comparison request made by this runner.
  const response = await client.compareByPlainlinkDetailed({ plainlink: PRODUCT_URL, store: "homedepot", requestId: "sovrn-homedepot-feasibility" });
  const offers = responseOffers(response.value);
  const sameRetailer = offers.filter(offer => {
    const name = text(offer.merchant?.name);
    return name?.toLowerCase() === "the home depot" && merchantMatchesStore("homedepot", { name });
  });
  const assessed = sameRetailer.map(offer => ({ offer, identity: identity(offer) }));
  const usable = assessed.filter(item => ["EXACT_VARIANT_MATCH", "NO_VARIANT_CONFLICT"].includes(item.identity.classification));
  // Observe the sole exact-merchant candidate before applying the unchanged
  // identity acceptance gate. These fields are diagnostic only and cannot make
  // an ambiguous candidate usable.
  const observed = assessed.length === 1 ? assessed[0] : undefined;
  const saleCents = cents(observed?.offer.salePrice);
  const retailCents = cents(observed?.offer.retailPrice);
  const imageUrl = text(observed?.offer.image);
  const imageUrlSyntacticallyValid = (() => {
    if (!imageUrl) return false;
    try { return new URL(imageUrl).protocol === "https:"; } catch { return false; }
  })();
  const image = await imageResult(observed?.offer.image, observed?.identity.classification ?? "SOURCE_IDENTITY_UNAVAILABLE");
  console.log(JSON.stringify({
    event: "sovrn_homedepot_feasibility_result", success: true, market: "usd_en", httpStatus: response.httpStatus,
    totalOfferCount: offers.length, homeDepotOfferCount: sameRetailer.length,
    canonicalMerchantMatched: sameRetailer.some(offer => text(offer.merchant?.name)?.trim().toLowerCase() === "the home depot"),
    selectedOfferCount: usable.length,
    observedCandidateCount: observed ? 1 : 0,
    merchantName: observed ? text(observed.offer.merchant?.name) : undefined,
    merchantId: observed?.offer.merchant?.id,
    model: observed?.identity.model,
    affiliatable: observed?.offer.affiliatable,
    currency: observed ? text(observed.offer.currency) : undefined,
    salePrice: observed ? finite(observed.offer.salePrice) : undefined,
    retailPrice: observed ? finite(observed.offer.retailPrice) : undefined,
    imageUrlSyntacticallyValid,
    identityClassification: observed?.identity.classification ?? "SOURCE_IDENTITY_UNAVAILABLE",
    identityEvidence: observed?.identity.evidence ?? {},
    homeDepotCurrentCents: SOURCE_CURRENT_CENTS, sovrnCurrentCents: saleCents,
    deltaCents: saleCents === undefined ? undefined : saleCents - SOURCE_CURRENT_CENTS,
    priceParity: saleCents === undefined ? "UNAVAILABLE" : saleCents === SOURCE_CURRENT_CENTS ? "EXACT" : "DIFFERENT",
    homeDepotReferenceCents: SOURCE_REFERENCE_CENTS, sovrnReferenceCents: retailCents,
    referenceParity: referenceParity(retailCents), image
  }));
}

main().catch(error => {
  const errorCode = error instanceof Error ? error.message.split(":")[0] : "SOVRN_HOMEDEPOT_PILOT_FAILED";
  console.error(JSON.stringify({ event: "sovrn_homedepot_feasibility_failed", success: false, errorCode }));
  process.exitCode = 2;
});
