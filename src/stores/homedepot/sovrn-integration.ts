import { ProductError, type ProductData } from "../../types";
import type { SovrnProductProvider, SovrnVariantClassification } from "../sovrn/types";
import { assessHomeDepotSovrnParity, type HomeDepotSovrnParity } from "./sovrn-feasibility";

export type HomeDepotSovrnStatus =
  | "ACCEPTED"
  | "NO_OFFER"
  | "NO_SAME_RETAILER"
  | "IDENTITY_REJECTED"
  | "PRICE_MISMATCH"
  | "INVALID_PRICE"
  | "INVALID_IMAGE"
  | "TIMEOUT"
  | "PROVIDER_ERROR"
  | "NOT_CONFIGURED";

export type HomeDepotSovrnDecision = {
  product: ProductData;
  telemetry: {
    event: "homedepot_sovrn_decision";
    sovrnStatus: HomeDepotSovrnStatus;
    identityClassification?: SovrnVariantClassification;
    priceParity: HomeDepotSovrnParity["currentParity"];
    sourceCurrentCents?: number;
    sovrnCurrentCents?: number;
    deltaCents?: number;
    referenceParity: HomeDepotSovrnParity["referenceParity"];
    sovrnImageValid: boolean;
    finalSource: "SOVRN_ENRICHED" | "HOME_DEPOT_FALLBACK";
  };
};

export type HomeDepotSovrnInput = {
  sourceProduct: ProductData;
  sourceHtml: string;
  requestId?: string;
  provider?: SovrnProductProvider;
  validateImage: (url: string) => Promise<void>;
};

const cents = (value: number | undefined): number | undefined => {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const result = Math.round((value + Number.EPSILON) * 100);
  return Number.isSafeInteger(result) && Math.abs(value * 100 - result) < 0.000_001 ? result : undefined;
};

function statusFor(error: unknown): HomeDepotSovrnStatus {
  if (!(error instanceof ProductError)) return "PROVIDER_ERROR";
  if (error.code === "SOVRN_NO_OFFER_FOR_PLAINLINK") return "NO_OFFER";
  if (error.code === "SOVRN_NO_SAME_RETAILER_OFFER") return "NO_SAME_RETAILER";
  if (["SOVRN_SOURCE_IDENTITY_UNAVAILABLE", "SOVRN_PRODUCT_MISMATCH", "SOVRN_VARIANT_CONFLICT", "SOVRN_VARIANT_AMBIGUOUS"].includes(error.code)) return "IDENTITY_REJECTED";
  if (error.code === "SOVRN_INVALID_PRICE") return "INVALID_PRICE";
  if (error.code === "SOVRN_INVALID_IMAGE") return "INVALID_IMAGE";
  if (error.code === "SOVRN_TIMEOUT") return "TIMEOUT";
  return "PROVIDER_ERROR";
}
function fallback(source: ProductData, sovrnStatus: HomeDepotSovrnStatus, extra: Partial<HomeDepotSovrnDecision["telemetry"]> = {}): HomeDepotSovrnDecision {
  return {
    product: source,
    telemetry: {
      event: "homedepot_sovrn_decision",
      sovrnStatus,
      priceParity: "UNAVAILABLE",
      sourceCurrentCents: cents(source.currentPrice.value),
      referenceParity: source.oldPrice ? "HOME_DEPOT_ONLY" : "NEITHER",
      sovrnImageValid: false,
      finalSource: "HOME_DEPOT_FALLBACK",
      ...extra
    }
  };
}

export async function enrichHomeDepotWithSovrn(input: HomeDepotSovrnInput): Promise<HomeDepotSovrnDecision> {
  const source = input.sourceProduct;
  if (!input.provider) return fallback(source, "NOT_CONFIGURED");

  let candidate;
  try {
    candidate = await input.provider.product({
      store: "homedepot",
      sourceProduct: source,
      postUrl: source.postUrl,
      resolvedUrl: source.resolvedUrl,
      sourceHtml: input.sourceHtml,
      requestId: input.requestId
    });
  } catch (error) {
    return fallback(source, statusFor(error));
  }

  const identityClassification = candidate.identity.variantClassification;
  if (!candidate.identity.productMatchConfirmed || !["EXACT_VARIANT_MATCH", "NO_VARIANT_CONFLICT"].includes(identityClassification)) {
    return fallback(source, "IDENTITY_REJECTED", { identityClassification });
  }

  const parity = assessHomeDepotSovrnParity(source, candidate.product, candidate.identity);
  const parityFields = {
    identityClassification,
    priceParity: parity.currentParity,
    sourceCurrentCents: parity.homeDepotCurrentCents,
    sovrnCurrentCents: parity.sovrnCurrentCents,
    deltaCents: parity.deltaCents,
    referenceParity: parity.referenceParity
  };
  if (parity.currentParity === "UNAVAILABLE") return fallback(source, "INVALID_PRICE", parityFields);
  if (parity.currentParity === "DIFFERENT") return fallback(source, "PRICE_MISMATCH", parityFields);

  try { await input.validateImage(candidate.product.imageUrl); }
  catch { return fallback(source, "INVALID_IMAGE", parityFields); }

  return {
    product: {
      ...source,
      rawTitle: candidate.product.rawTitle,
      imageUrl: candidate.product.imageUrl
    },
    telemetry: {
      event: "homedepot_sovrn_decision",
      sovrnStatus: "ACCEPTED",
      ...parityFields,
      sovrnImageValid: true,
      finalSource: "SOVRN_ENRICHED"
    }
  };
}
