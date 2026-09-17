import { SovrnApiError, type SovrnApiResult } from "./client";
import { sovrnMerchantAdapters } from "./merchant-registry";
import { buildSovrnPlainlink } from "./plainlink";
import { describeSovrnPriceResponse } from "./response-shape";
import type { SovrnApprovedMerchantFinding, SovrnStoreId } from "./types";

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

export async function runSovrnPilotLookups(input: {
  candidates: ReadonlyArray<{ store: SovrnStoreId; url: string }>;
  merchantFindings: readonly SovrnApprovedMerchantFinding[];
  compare: (lookup: { plainlink: string; store: SovrnStoreId; requestId?: string }) => Promise<SovrnApiResult>;
  delay?: (ms: number) => Promise<void>;
}): Promise<unknown[]> {
  const delay = input.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const results: unknown[] = [];
  for (const [index, candidate] of input.candidates.entries()) {
    try {
      const lookup = buildSovrnPlainlink(candidate.url, candidate.store);
      const domain = sovrnMerchantAdapters[candidate.store].domains[0];
      const approvedMetadata = input.merchantFindings.find(finding => finding.domain === domain)?.approved === true;
      const response = await input.compare({ plainlink: lookup.plainlink, store: candidate.store, requestId: "sovrn-feasibility" });
      results.push({
        store: candidate.store, hostname: new URL(lookup.plainlink).hostname, approvedMetadata, httpStatus: response.httpStatus,
        pathShape: new URL(lookup.plainlink).pathname.replace(/[A-Za-z0-9]{6,}/g, ":id"),
        productIdentityPresent: Boolean(lookup.productIdentity), structure: describeSovrnPriceResponse(response.value)
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
