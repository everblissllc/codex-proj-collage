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

export function classifySovrnReferencePrice(salePrice?: number, retailPrice?: number): SovrnReferenceClassification {
  if (!Number.isFinite(salePrice) || (salePrice ?? 0) <= 0 || !Number.isFinite(retailPrice) || (retailPrice ?? 0) <= 0) {
    return "invalid_or_absent";
  }
  if (retailPrice! > salePrice!) return "valid_reference_candidate";
  if (retailPrice === salePrice) return "equal_no_discount";
  return "inconsistent";
}

export function isSovrnOfferPotentiallyUsable(input: {
  sameRetailer: boolean;
  affiliatable?: boolean;
  exactIdentityConfirmed: boolean;
  salePrice?: number;
  currency?: string;
  imagePresent: boolean;
  imageHttps?: boolean;
}): boolean {
  return input.sameRetailer && input.affiliatable === true && input.exactIdentityConfirmed &&
    Number.isFinite(input.salePrice) && input.salePrice! > 0 && input.currency === "USD" &&
    input.imagePresent && input.imageHttps === true;
}

export function parseSovrnPilotCandidates(value: string): SovrnPilotCandidate[] {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid candidates");
  const input = parsed as Record<string, unknown>;
  if (Object.keys(input).length !== SOVRN_PILOT_STORES.length || Object.keys(input).some(store => !SOVRN_PILOT_STORES.includes(store as SovrnStoreId))) {
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

export function summarizeSovrnPilotLookup(result: SovrnPilotLookupResult): Record<string, unknown> {
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
  const technicalUsability = representative ? isSovrnOfferPotentiallyUsable({
    sameRetailer: true,
    affiliatable: representative.affiliatable,
    exactIdentityConfirmed: identityConfidence === "confirmed",
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
