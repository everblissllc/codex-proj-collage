import { SovrnClient } from "../src/stores/sovrn/client";
import { runSovrnPilotLookups, summarizeSovrnPilotLookup, type SovrnPilotCandidate } from "../src/stores/sovrn/feasibility";
import { merchantMatchesStore } from "../src/stores/sovrn/merchant-registry";
import { assessSovrnPilotIdentity, fetchSovrnSourceIdentities } from "../src/stores/sovrn/source-identity-feasibility";

const WALMART_CANDIDATE = "https://www.walmart.com/ip/Ninja-Coffee-Machine-PB045/13162221820";
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
  if (mimeType === "image/png") return bytes.length >= 24 && [137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value);
  if (mimeType === "image/jpeg") return bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes.at(-2) === 255 && bytes.at(-1) === 217;
  return mimeType === "image/webp" && bytes.length >= 30 && String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP";
}

async function validateImage(value: unknown): Promise<Record<string, unknown>> {
  if (typeof value !== "string") return { valid: false, errorCode: "IMAGE_MISSING" };
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return { valid: false, https: false, errorCode: "IMAGE_NOT_HTTPS" };
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(12_000), headers: { accept: "image/avif,image/webp,image/png,image/jpeg" } });
    const mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
    if (!["image/png", "image/jpeg", "image/webp"].includes(mimeType)) return { valid: false, https: true, hostname: url.hostname, mimeType, errorCode: "IMAGE_TYPE_INVALID" };
    const bytes = await readBoundedBytes(response, 6_000_000);
    const signatureValid = imageSignature(bytes, mimeType);
    return { valid: signatureValid, https: true, hostname: url.hostname, mimeType, byteSize: bytes.byteLength, signatureValid };
  } catch (error) {
    return { valid: false, errorCode: error instanceof Error ? error.message.slice(0, 80) : "IMAGE_VALIDATION_FAILED" };
  }
}

async function main(): Promise<void> {
  const missingKeys = requiredKeys.filter(key => !process.env[key]);
  if (missingKeys.length) {
    console.error(JSON.stringify({ event: "sovrn_walmart_failed", errorCode: "SOVRN_CONFIG_MISSING", missingKeys }));
    process.exitCode = 2;
    return;
  }
  if (process.env.SOVRN_MARKET !== "usd_en") {
    console.error(JSON.stringify({ event: "sovrn_walmart_failed", errorCode: "SOVRN_MARKET_INVALID", invalidKey: "SOVRN_MARKET" }));
    process.exitCode = 2;
    return;
  }

  const candidate: SovrnPilotCandidate = { store: "walmart", url: WALMART_CANDIDATE };
  const client = new SovrnClient({ secretKey: process.env.SOVRN_SECRET_KEY!, siteApiKey: process.env.SOVRN_SITE_API_KEY!, market: "usd_en" });
  const apiResponse = await client.compareByPlainlinkDetailed({ plainlink: WALMART_CANDIDATE, store: "walmart", requestId: "sovrn-walmart-pilot" });
  const [lookup] = await runSovrnPilotLookups({ candidates: [candidate], merchantFindings: [], delay: async () => {}, compare: async () => apiResponse });
  const [source] = await fetchSovrnSourceIdentities([candidate]);
  const identityAssessment = assessSovrnPilotIdentity(lookup, source);
  const result = summarizeSovrnPilotLookup(lookup, identityAssessment);
  const sameRetailerWireOffers = responseOffers(apiResponse.value).filter(offer => merchantMatchesStore("walmart", { name: typeof offer.merchant?.name === "string" ? offer.merchant.name : undefined }));
  const selectedWireOffer = sameRetailerWireOffers.length === 1 ? sameRetailerWireOffers[0] : undefined;
  const imageValidation = await validateImage(selectedWireOffer?.image);
  const technicalUsability = result.technicalUsability === true && imageValidation.valid === true;
  const summaryOffer = result.sameRetailerOffer && typeof result.sameRetailerOffer === "object"
    ? result.sameRetailerOffer as Record<string, unknown>
    : undefined;

  console.log(JSON.stringify({
    event: "sovrn_walmart_result", market: "usd_en",
    candidate: { hostname: "www.walmart.com", itemId: "13162221820", pathShape: "/ip/:slug/:itemId" },
    ...result, identityAssessment,
    resultIdSemantics: "OPAQUE_SOVRN_METADATA", resultIdComparedToWalmartItemId: false,
    sourceIdentity: source, existingWalmartExtractor: source?.existingProduct,
    existingWalmartExtractorError: source?.existingProductError, imageValidation, technicalUsability,
    normalizedProductData: technicalUsability && summaryOffer ? {
      store: "walmart", rawTitle: summaryOffer.name,
      currentPrice: { value: summaryOffer.salePrice, currency: summaryOffer.currency },
      referencePrice: result.referencePriceClassification === "valid_reference_candidate"
        ? { value: summaryOffer.retailPrice, currency: summaryOffer.currency } : undefined,
      imagePresent: Boolean((summaryOffer.image as Record<string, unknown> | undefined)?.present),
      postUrlPreserved: true, sovrnDeeplinkUsedAsPostUrl: false
    } : undefined
  }));
}

main().catch(error => {
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "SOVRN_PILOT_FAILED";
  console.error(JSON.stringify({ event: "sovrn_walmart_failed", errorCode }));
  process.exitCode = 2;
});
