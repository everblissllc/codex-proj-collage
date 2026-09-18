import { ProductError, type ProductData } from "../../types";
import type { SovrnProductProvider, SovrnVariantClassification } from "./types";

export type WalmartSovrnStatus =
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

export type WalmartSovrnPriceParity = "EXACT" | "DIFFERENT" | "UNAVAILABLE";
export type WalmartSovrnReferenceParity = "EXACT" | "DIFFERENT" | "WALMART_ONLY" | "SOVRN_ONLY" | "NEITHER";

export type WalmartSovrnDecision = {
  product: ProductData;
  telemetry: {
    event: "walmart_sovrn_decision";
    sovrnStatus: WalmartSovrnStatus;
    identityClassification?: SovrnVariantClassification;
    priceParity: WalmartSovrnPriceParity;
    walmartCurrentCents?: number;
    sovrnCurrentCents?: number;
    deltaCents?: number;
    referenceParity: WalmartSovrnReferenceParity;
    sovrnImageValid: boolean;
    finalSource: "SOVRN_ENRICHED" | "WALMART_FALLBACK";
  };
};

export type WalmartSovrnInput = {
  sourceProduct: ProductData;
  sourceHtml: string;
  requestId?: string;
  provider?: SovrnProductProvider;
  validateImage: (url: string) => Promise<void>;
};

export function moneyCents(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  const cents = Math.round((value + Number.EPSILON) * 100);
  return Number.isSafeInteger(cents) && Math.abs(value * 100 - cents) < 0.000_001 ? cents : undefined;
}

export function walmartSovrnReferenceParity(walmart: ProductData["oldPrice"], sovrn: ProductData["oldPrice"]): WalmartSovrnReferenceParity {
  const walmartCents = moneyCents(walmart?.value);
  const sovrnCents = moneyCents(sovrn?.value);
  if (walmartCents === undefined && sovrnCents === undefined) return "NEITHER";
  if (walmartCents !== undefined && sovrnCents === undefined) return "WALMART_ONLY";
  if (walmartCents === undefined) return "SOVRN_ONLY";
  return walmartCents === sovrnCents ? "EXACT" : "DIFFERENT";
}

function statusFor(error: unknown): WalmartSovrnStatus {
  if (!(error instanceof ProductError)) return "PROVIDER_ERROR";
  if (error.code === "SOVRN_NO_OFFER_FOR_PLAINLINK") return "NO_OFFER";
  if (error.code === "SOVRN_NO_SAME_RETAILER_OFFER") return "NO_SAME_RETAILER";
  if (["SOVRN_SOURCE_IDENTITY_UNAVAILABLE", "SOVRN_PRODUCT_MISMATCH", "SOVRN_VARIANT_CONFLICT", "SOVRN_VARIANT_AMBIGUOUS"].includes(error.code)) return "IDENTITY_REJECTED";
  if (error.code === "SOVRN_INVALID_PRICE") return "INVALID_PRICE";
  if (error.code === "SOVRN_INVALID_IMAGE") return "INVALID_IMAGE";
  if (error.code === "SOVRN_TIMEOUT") return "TIMEOUT";
  return "PROVIDER_ERROR";
}

function fallback(sourceProduct: ProductData, sovrnStatus: WalmartSovrnStatus, extra: Partial<WalmartSovrnDecision["telemetry"]> = {}): WalmartSovrnDecision {
  return {
    product: sourceProduct,
    telemetry: {
      event: "walmart_sovrn_decision",
      sovrnStatus,
      priceParity: "UNAVAILABLE",
      walmartCurrentCents: moneyCents(sourceProduct.currentPrice.value),
      referenceParity: sourceProduct.oldPrice ? "WALMART_ONLY" : "NEITHER",
      sovrnImageValid: false,
      finalSource: "WALMART_FALLBACK",
      ...extra
    }
  };
}

export async function enrichWalmartWithSovrn(input: WalmartSovrnInput): Promise<WalmartSovrnDecision> {
  const walmart = input.sourceProduct;
  if (!input.provider) return fallback(walmart, "NOT_CONFIGURED");

  let candidate;
  try {
    candidate = await input.provider.product({
      store: "walmart",
      sourceProduct: walmart,
      postUrl: walmart.postUrl,
      resolvedUrl: walmart.resolvedUrl,
      sourceHtml: input.sourceHtml,
      requestId: input.requestId
    });
  } catch (error) {
    return fallback(walmart, statusFor(error));
  }

  const identityClassification = candidate.identity.variantClassification;
  if (!candidate.identity.productMatchConfirmed || !["EXACT_VARIANT_MATCH", "NO_VARIANT_CONFLICT"].includes(identityClassification)) {
    return fallback(walmart, "IDENTITY_REJECTED", { identityClassification });
  }

  const walmartCurrentCents = moneyCents(walmart.currentPrice.value);
  const sovrnCurrentCents = moneyCents(candidate.product.currentPrice.value);
  const referenceParity = walmartSovrnReferenceParity(walmart.oldPrice, candidate.product.oldPrice);
  if (walmartCurrentCents === undefined || sovrnCurrentCents === undefined || walmart.currentPrice.currency !== candidate.product.currentPrice.currency) {
    return fallback(walmart, "INVALID_PRICE", {
      identityClassification, walmartCurrentCents, sovrnCurrentCents, referenceParity,
      priceParity: "UNAVAILABLE"
    });
  }
  const deltaCents = sovrnCurrentCents - walmartCurrentCents;
  if (deltaCents !== 0) {
    return fallback(walmart, "PRICE_MISMATCH", {
      identityClassification, walmartCurrentCents, sovrnCurrentCents, deltaCents, referenceParity,
      priceParity: "DIFFERENT"
    });
  }

  try {
    await input.validateImage(candidate.product.imageUrl);
  } catch {
    return fallback(walmart, "INVALID_IMAGE", {
      identityClassification, walmartCurrentCents, sovrnCurrentCents, deltaCents, referenceParity,
      priceParity: "EXACT"
    });
  }

  // Walmart remains authoritative for identity, prices, canonical URL, and exact postUrl.
  // Sovrn may enrich only the already-validated title and image.
  const product: ProductData = {
    ...walmart,
    rawTitle: candidate.product.rawTitle,
    imageUrl: candidate.product.imageUrl
  };
  return {
    product,
    telemetry: {
      event: "walmart_sovrn_decision",
      sovrnStatus: "ACCEPTED",
      identityClassification,
      priceParity: "EXACT",
      walmartCurrentCents,
      sovrnCurrentCents,
      deltaCents,
      referenceParity,
      sovrnImageValid: true,
      finalSource: "SOVRN_ENRICHED"
    }
  };
}
