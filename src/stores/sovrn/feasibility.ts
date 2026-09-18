import { SovrnApiError, type SovrnApiResult } from "./client";
import { merchantMatchesStore, sovrnMerchantAdapters } from "./merchant-registry";
import { buildSovrnPlainlink } from "./plainlink";
import { describeSovrnPriceResponse } from "./response-shape";
import type { SovrnApprovedMerchantFinding, SovrnPilotOfferSummary, SovrnPilotPriceSummary, SovrnStoreId } from "./types";

export const SOVRN_PILOT_STORES = ["target", "nordstrom", "ulta", "sephora", "ecosmetics", "bubble"] as const;

export type SovrnPilotCandidate = { store: SovrnStoreId; url: string };

export type SovrnPilotLookupResult = {
  store: SovrnStoreId;
  hostname?: string;
  approvedMetadata?: boolean;
  httpStatus?: number;
  pathShape?: string;
  lookupIdentity?: string;
  structure?: SovrnPilotPriceSummary;
  errorCode?: string;
};

export type SovrnReferenceClassification =
  | "valid_reference_candidate"
  | "equal_no_discount"
  | "inconsistent"
  | "invalid_or_absent";

export type SovrnVariantClassification =
  | "EXACT_VARIANT_MATCH"
  | "NO_VARIANT_CONFLICT"
  | "VARIANT_CONFLICT"
  | "VARIANT_AMBIGUOUS_HIGH_RISK";

export type SovrnVariantEvidence = {
  explicit: boolean;
  multiVariantFamily?: boolean;
  size?: string;
  shade?: string;
  color?: string;
  pack?: string;
  container?: string;
  variantId?: string;
  sku?: string;
  upc?: string;
  gtin?: string;
  mpn?: string;
};

export function classifySovrnReferencePrice(salePrice?: number, retailPrice?: number): SovrnReferenceClassification {
  if (!Number.isFinite(salePrice) || (salePrice ?? 0) <= 0 || !Number.isFinite(retailPrice) || (retailPrice ?? 0) <= 0) {
    return "invalid_or_absent";
  }
  if (retailPrice! > salePrice!) return "valid_reference_candidate";
  if (retailPrice === salePrice) return "equal_no_discount";
  return "inconsistent";
}

const normalizedVariantValue = (value: string): string => value.trim().toLowerCase()
  .replace(/fluid ounces?|fl\.?\s*oz\.?/g, "floz")
  .replace(/ounces?|oz\.?/g, "oz")
  .replace(/millilit(?:er|re)s?|ml/g, "ml")
  .replace(/[^a-z0-9.]+/g, "");

export function classifySovrnVariantMatch(
  source: SovrnVariantEvidence,
  offer: SovrnVariantEvidence
): SovrnVariantClassification {
  const comparable: Array<keyof Omit<SovrnVariantEvidence, "explicit" | "multiVariantFamily">> = [
    "size", "shade", "color", "pack", "container", "variantId", "sku", "upc", "gtin", "mpn"
  ];
  let matchedEvidence = false;
  for (const key of comparable) {
    const sourceValue = source[key];
    const offerValue = offer[key];
    if (typeof sourceValue !== "string" || typeof offerValue !== "string") continue;
    if (normalizedVariantValue(sourceValue) !== normalizedVariantValue(offerValue)) return "VARIANT_CONFLICT";
    matchedEvidence = true;
  }
  if (source.explicit && offer.explicit && matchedEvidence) return "EXACT_VARIANT_MATCH";
  if (source.multiVariantFamily === true && !source.explicit && offer.explicit) return "VARIANT_AMBIGUOUS_HIGH_RISK";
  return "NO_VARIANT_CONFLICT";
}

export function isSovrnOfferPotentiallyUsable(input: {
  sameRetailer: boolean;
  affiliatable?: boolean;
  productMatchConfirmed: boolean;
  variantClassification: SovrnVariantClassification;
  salePrice?: number;
  currency?: string;
  imagePresent: boolean;
  imageHttps?: boolean;
}): boolean {
  const variantAccepted = input.variantClassification === "EXACT_VARIANT_MATCH" || input.variantClassification === "NO_VARIANT_CONFLICT";
  return input.sameRetailer && input.affiliatable === true && input.productMatchConfirmed && variantAccepted &&
    Number.isFinite(input.salePrice) && input.salePrice! > 0 && input.currency === "USD" &&
    input.imagePresent && input.imageHttps === true;
}

export function parseSovrnPilotCandidates(value: string): SovrnPilotCandidate[] {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid candidates");
  const input = parsed as Record<string, unknown>;
  if (Object.keys(input).length !== SOVRN_PILOT_STORES.length || Object.keys(input).some(store => !(SOVRN_PILOT_STORES as readonly string[]).includes(store))) {
    throw new Error("invalid candidate stores");
  }
  return SOVRN_PILOT_STORES.map(store => {
    const url = input[store];
    if (typeof url !== "string" || !url.trim()) throw new Error("invalid candidate URL");
    return { store, url };
  });
}

const normalizedIdentity = (value: string | number | boolean): string => String(value).toLowerCase().replace(/[^a-z0-9]/g, "");

function matchingIdentity(offer: SovrnPilotOfferSummary, lookupIdentity?: string): boolean {
  if (!lookupIdentity) return false;
  const expected = normalizedIdentity(lookupIdentity);
  return offer.strongerIdentityFields.some(field => normalizedIdentity(field.value) === expected);
}

export function summarizeSovrnPilotLookup(
  result: SovrnPilotLookupResult,
  assessment?: { productMatchConfirmed: boolean; variantClassification: SovrnVariantClassification }
): Record<string, unknown> {
  if (!result.structure) return result;
  const offers = result.structure.offers;
  const sameRetailerOffers = offers.filter(offer => merchantMatchesStore(result.store, { name: offer.merchant.name }));
  const exactMatches = sameRetailerOffers.filter(offer => matchingIdentity(offer, result.lookupIdentity));
  const representative = exactMatches.length === 1 ? exactMatches[0] : sameRetailerOffers.length === 1 ? sameRetailerOffers[0] : undefined;
  const identityConfidence = exactMatches.length === 1
    ? "confirmed"
    : sameRetailerOffers.length > 0 ? "ambiguous" : "no_same_retailer";
  const referencePriceClassification = representative
    ? classifySovrnReferencePrice(representative.salePrice, representative.retailPrice)
    : "invalid_or_absent";
  const resolvedAssessment = assessment ?? (identityConfidence === "confirmed"
    ? { productMatchConfirmed: true, variantClassification: "NO_VARIANT_CONFLICT" as const }
    : { productMatchConfirmed: false, variantClassification: "NO_VARIANT_CONFLICT" as const });
  const technicalUsability = representative ? isSovrnOfferPotentiallyUsable({
    sameRetailer: true,
    affiliatable: representative.affiliatable,
    productMatchConfirmed: resolvedAssessment.productMatchConfirmed,
    variantClassification: resolvedAssessment.variantClassification,
    salePrice: representative.salePrice,
    currency: representative.currency,
    imagePresent: representative.image.present,
    imageHttps: representative.image.https
  }) : false;
  return {
    ...result,
    allMerchants: offers.map(offer => ({
      name: offer.merchant.name,
      id: offer.merchant.id,
      affiliatable: offer.affiliatable
    })),
    sameRetailerMatch: sameRetailerOffers.length > 0,
    sameRetailerOfferCount: sameRetailerOffers.length,
    sameRetailerOffer: representative,
    identityConfidence,
    variantClassification: resolvedAssessment.variantClassification,
    referencePriceClassification,
    technicalUsability
  };
}

export async function runSovrnPilotLookups(input: {
  candidates: ReadonlyArray<SovrnPilotCandidate>;
  merchantFindings: readonly SovrnApprovedMerchantFinding[];
  compare: (lookup: { plainlink: string; store: SovrnStoreId; requestId?: string }) => Promise<SovrnApiResult>;
  delay?: (ms: number) => Promise<void>;
}): Promise<SovrnPilotLookupResult[]> {
  const delay = input.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const results: SovrnPilotLookupResult[] = [];
  for (const [index, candidate] of input.candidates.entries()) {
    try {
      const lookup = buildSovrnPlainlink(candidate.url, candidate.store);
      const domain = sovrnMerchantAdapters[candidate.store].domains[0];
      const approvedMetadata = input.merchantFindings.find(finding => finding.domain === domain)?.approved === true;
      const response = await input.compare({ plainlink: lookup.plainlink, store: candidate.store, requestId: "sovrn-feasibility" });
      results.push({
        store: candidate.store, hostname: new URL(lookup.plainlink).hostname, approvedMetadata, httpStatus: response.httpStatus,
        pathShape: new URL(lookup.plainlink).pathname.replace(/[A-Za-z0-9]{6,}/g, ":id"),
        lookupIdentity: lookup.productIdentity,
        structure: describeSovrnPriceResponse(response.value)
      });
    } catch (error) {
      results.push({
        store: candidate.store,
        httpStatus: error instanceof SovrnApiError ? error.httpStatus : undefined,
        errorCode: error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "SOVRN_PILOT_FAILED"
      });
    }
    if (index < input.candidates.length - 1) await delay(250);
  }
  return results;
}
