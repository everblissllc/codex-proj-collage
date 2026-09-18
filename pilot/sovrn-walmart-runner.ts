import { SovrnClient } from "../src/stores/sovrn/client";
import { runSovrnPilotLookups, summarizeSovrnPilotLookup, type SovrnPilotCandidate } from "../src/stores/sovrn/feasibility";
import { merchantMatchesStore } from "../src/stores/sovrn/merchant-registry";
import { assessSovrnPilotIdentity, fetchSovrnSourceIdentities } from "../src/stores/sovrn/source-identity-feasibility";
import { resolveUrl } from "../src/stores/resolve-url";

const WALMART_CANDIDATES = [
  { label: "PRODUCT_1_SIMPLE", itemId: "19658170815", url: "https://www.walmart.com/ip/Ozark-Trail-Disposable-Instant-Charcoal-Grill-with-540g-Charcoal-Content/19658170815" },
  { label: "PRODUCT_2_DISCOUNTED", itemId: "746021606", url: "https://www.walmart.com/ip/Expert-Grill-Heavy-Duty-24-inch-Charcoal-Grill-Black/746021606" },
  { label: "PRODUCT_3_MULTI_VARIANT", itemId: "18317156543", url: "https://www.walmart.com/ip/Ninja-Blendboss-Tumbler-Blender-with-26oz-Travel-Tumbler-Cyberspace-DB351CY/18317156543" }
] as const;
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

async function readBoundedBytes(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.ok) throw new Error("IMAGE_HTTP_ERROR");
  if (Number(response.headers.get("content-length")) > maxBytes) throw new Error("IMAGE_TOO_LARGE");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("IMAGE_EMPTY");
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new Error("IMAGE_TOO_LARGE"); }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return bytes;
}

function imageSignature(bytes: Uint8Array, mimeType: string): boolean {
  if (mimeType === "image/png") return bytes.length >= 8 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (mimeType === "image/jpeg") return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return mimeType === "image/webp" && bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
}

async function validateImage(value: unknown): Promise<Record<string, unknown>> {
  if (typeof value !== "string") return { valid: false, errorCode: "IMAGE_MISSING" };
  try {
    const page = await resolveUrl(value, undefined, "image/webp,image/png,image/jpeg");
    const finalUrl = new URL(page.resolvedUrl);
    const mimeType = page.response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) {
      await page.response.body?.cancel();
      return { valid: false, https: finalUrl.protocol === "https:", hostname: finalUrl.hostname, mimeType, errorCode: "IMAGE_TYPE_INVALID" };
    }
    const bytes = await readBoundedBytes(page.response, 6_000_000);
    const signatureValid = imageSignature(bytes, mimeType);
    return {
      valid: signatureValid, https: finalUrl.protocol === "https:", hostname: finalUrl.hostname,
      mimeType, byteSize: bytes.byteLength, signatureValid, redirectCount: page.redirectCount
    };
  } catch (error) {
    return { valid: false, errorCode: error && typeof error === "object" && "code" in error ? String(error.code) : "IMAGE_VALIDATION_FAILED" };
  }
}

const cents = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? Math.round(value * 100) : undefined;
function referenceValue(sale: unknown, retail: unknown): number | undefined {
  return typeof sale === "number" && typeof retail === "number" && Number.isFinite(sale) && Number.isFinite(retail) && retail > sale && sale > 0
    ? retail : undefined;
}
function referenceParity(walmart?: number, sovrn?: number): string {
  if (walmart === undefined && sovrn === undefined) return "NEITHER";
  if (walmart === undefined) return "SOVRN_ONLY";
  if (sovrn === undefined) return "WALMART_ONLY";
  return cents(walmart) === cents(sovrn) ? "EXACT" : "DIFFERENT";
}

async function main(): Promise<void> {
  const missingKeys = requiredKeys.filter(key => !process.env[key]);
  if (missingKeys.length) {
    console.error(JSON.stringify({ event: "sovrn_walmart_parity_failed", errorCode: "SOVRN_CONFIG_MISSING", missingKeys }));
    process.exitCode = 2;
    return;
  }
  if (process.env.SOVRN_MARKET !== "usd_en") {
    console.error(JSON.stringify({ event: "sovrn_walmart_parity_failed", errorCode: "SOVRN_MARKET_INVALID", invalidKey: "SOVRN_MARKET" }));
    process.exitCode = 2;
    return;
  }

  const candidates: SovrnPilotCandidate[] = WALMART_CANDIDATES.map(candidate => ({ store: "walmart", url: candidate.url }));
  const sources = await fetchSovrnSourceIdentities(candidates);
  const client = new SovrnClient({ secretKey: process.env.SOVRN_SECRET_KEY!, siteApiKey: process.env.SOVRN_SITE_API_KEY!, market: "usd_en" });
  const results: Record<string, unknown>[] = [];

  for (const [index, candidate] of WALMART_CANDIDATES.entries()) {
    const apiResponse = await client.compareByPlainlinkDetailed({
      plainlink: candidate.url, store: "walmart", requestId: `sovrn-walmart-parity-${index + 1}`
    });
    const [lookup] = await runSovrnPilotLookups({
      candidates: [{ store: "walmart", url: candidate.url }], merchantFindings: [], delay: async () => {}, compare: async () => apiResponse
    });
    const source = sources[index];
    const identityAssessment = assessSovrnPilotIdentity(lookup, source);
    const summary = summarizeSovrnPilotLookup(lookup, identityAssessment);
    const allWireOffers = responseOffers(apiResponse.value);
    const sameRetailerWireOffers = allWireOffers.filter(offer => merchantMatchesStore("walmart", {
      name: typeof offer.merchant?.name === "string" ? offer.merchant.name : undefined
    }));
    const selectedWireOffer = sameRetailerWireOffers.length === 1 ? sameRetailerWireOffers[0] : undefined;
    const imageValidation = await validateImage(selectedWireOffer?.image);
    const summaryOffer = summary.sameRetailerOffer && typeof summary.sameRetailerOffer === "object"
      ? summary.sameRetailerOffer as Record<string, unknown> : undefined;
    const walmartCurrent = source?.existingProduct?.currentPrice.value;
    const walmartReference = source?.existingProduct?.oldPrice?.value;
    const sovrnCurrent = summaryOffer?.salePrice;
    const sovrnReference = referenceValue(summaryOffer?.salePrice, summaryOffer?.retailPrice);
    const currentParity = walmartCurrent === undefined || typeof sovrnCurrent !== "number"
      ? "UNAVAILABLE" : cents(walmartCurrent) === cents(sovrnCurrent) ? "EXACT" : "DIFFERENT";
    const variantAccepted = ["EXACT_VARIANT_MATCH", "NO_VARIANT_CONFLICT"].includes(identityAssessment.variantClassification);
    const imageParity = imageValidation.valid === true && variantAccepted ? "CONSISTENT_WITH_SELECTED_IDENTITY" : "UNCONFIRMED";
    const usable = summary.technicalUsability === true && imageValidation.valid === true &&
      source?.walmartSelectedVariant?.identityStatus === "CONFIRMED";
    const merchant = summaryOffer && typeof summaryOffer.merchant === "object"
      ? summaryOffer.merchant as Record<string, unknown> : undefined;
    results.push({
      label: candidate.label,
      candidate: { hostname: "www.walmart.com", itemId: candidate.itemId, pathShape: "/ip/:slug/:itemId" },
      sovrn: {
        httpStatus: apiResponse.httpStatus, totalOffers: allWireOffers.length,
        sameRetailerOfferCount: sameRetailerWireOffers.length,
        allMerchantNames: allWireOffers.map(offer => typeof offer.merchant?.name === "string" ? offer.merchant.name : undefined).filter(Boolean),
        merchantName: merchant?.name, merchantId: merchant?.id,
        affiliatable: summaryOffer?.affiliatable, title: summaryOffer?.name,
        salePrice: summaryOffer?.salePrice, retailPrice: summaryOffer?.retailPrice,
        acceptedReferencePrice: sovrnReference, currency: summaryOffer?.currency,
        imagePresent: Boolean((summaryOffer?.image as Record<string, unknown> | undefined)?.present),
        thumbnailPresent: Boolean((summaryOffer?.thumbnail as Record<string, unknown> | undefined)?.present),
        imageValidation
      },
      walmartSource: {
        httpStatus: source?.httpStatus, sourceProductId: source?.sourceProductId,
        canonicalItemId: source?.canonical?.pathname.match(/\/(\d+)(?:\/)?$/)?.[1],
        selectedVariant: source?.walmartSelectedVariant,
        title: source?.existingProduct?.rawTitle,
        currentPrice: walmartCurrent, referencePrice: walmartReference,
        imageHostname: source?.existingProduct?.imageHostname,
        postUrlPreserved: source?.existingProduct?.postUrlPreserved,
        extractionError: source?.existingProductError ?? source?.errorCode
      },
      identityAssessment,
      priceParity: {
        walmartCurrent, sovrnCurrent,
        deltaCents: walmartCurrent !== undefined && typeof sovrnCurrent === "number" ? cents(sovrnCurrent)! - cents(walmartCurrent)! : undefined,
        current: currentParity, walmartReference, sovrnReference,
        reference: referenceParity(walmartReference, sovrnReference),
        twoCentReferenceSpread: typeof sovrnCurrent === "number" && typeof sovrnReference === "number" &&
          cents(sovrnReference)! - cents(sovrnCurrent)! === 2
      },
      imageParity, usable,
      postUrlPreserved: source?.existingProduct?.postUrlPreserved === true,
      sovrnDeeplinkUsedAsPostUrl: false
    });
    if (index < WALMART_CANDIDATES.length - 1) await new Promise(resolve => setTimeout(resolve, 250));
  }

  console.log(JSON.stringify({
    event: "sovrn_walmart_parity_result", success: true, market: "usd_en",
    candidateCount: WALMART_CANDIDATES.length, results
  }));
}

main().catch(error => {
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code : "SOVRN_PILOT_FAILED";
  console.error(JSON.stringify({ event: "sovrn_walmart_parity_failed", errorCode }));
  process.exitCode = 2;
});
