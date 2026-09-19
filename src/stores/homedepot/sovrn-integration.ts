import { ProductError, type ProductData } from "../../types";
import type { SovrnProductProvider } from "../sovrn/types";
import { homeDepotIdentityFromUrl, type HomeDepotUrlIdentity } from "./url-identity";

export type HomeDepotSovrnStatus =
  | "ACCEPTED" | "NO_OFFER" | "NO_SAME_RETAILER" | "AMBIGUOUS_OFFER" | "IDENTITY_REJECTED"
  | "INVALID_PRICE" | "INVALID_IMAGE" | "TIMEOUT" | "PROVIDER_ERROR" | "NOT_CONFIGURED";
export type HomeDepotReferenceStatus = "VALID" | "ABSENT" | "SUPPRESSED_INVALID";

export type HomeDepotSovrnDecision = {
  product?: ProductData;
  error?: ProductError;
  telemetry: {
    event: "homedepot_sovrn_decision";
    sovrnStatus: HomeDepotSovrnStatus;
    sameRetailerOfferCount?: number;
    currentPriceValid: boolean;
    referencePriceStatus: HomeDepotReferenceStatus;
    sovrnImageValid: boolean;
    finalSource: "SOVRN_PRIMARY" | "NONE";
  };
};

export type HomeDepotSovrnInput = {
  postUrl: string;
  resolvedUrl: string;
  requestId?: string;
  provider?: SovrnProductProvider;
  validateImage: (url: string) => Promise<void>;
};

function statusFor(error: unknown): HomeDepotSovrnStatus {
  if (!(error instanceof ProductError)) return "PROVIDER_ERROR";
  if (error.code === "SOVRN_NO_OFFER_FOR_PLAINLINK") return "NO_OFFER";
  if (error.code === "SOVRN_NO_SAME_RETAILER_OFFER") return "NO_SAME_RETAILER";
  if (error.code === "HOME_DEPOT_AMBIGUOUS_OFFER") return "AMBIGUOUS_OFFER";
  if (["SOVRN_SOURCE_IDENTITY_UNAVAILABLE", "SOVRN_PRODUCT_MISMATCH", "SOVRN_VARIANT_CONFLICT", "SOVRN_VARIANT_AMBIGUOUS"].includes(error.code)) return "IDENTITY_REJECTED";
  if (error.code === "SOVRN_INVALID_PRICE") return "INVALID_PRICE";
  if (error.code === "SOVRN_INVALID_IMAGE") return "INVALID_IMAGE";
  if (error.code === "SOVRN_TIMEOUT") return "TIMEOUT";
  if (error.code === "SOVRN_NOT_CONFIGURED") return "NOT_CONFIGURED";
  return "PROVIDER_ERROR";
}

function failed(error: unknown, extra: Partial<HomeDepotSovrnDecision["telemetry"]> = {}): HomeDepotSovrnDecision {
  const productError = error instanceof ProductError ? error : new ProductError("SOVRN_PROVIDER_ERROR", "extraction", "Home Depot product data is unavailable");
  return {
    error: productError,
    telemetry: {
      event: "homedepot_sovrn_decision", sovrnStatus: statusFor(productError), currentPriceValid: false,
      referencePriceStatus: "ABSENT", sovrnImageValid: false, finalSource: "NONE", ...extra
    }
  };
}

function homeDepotProduct(identity: HomeDepotUrlIdentity, candidate: ProductData, postUrl: string, resolvedUrl: string): ProductData {
  return {
    store: "homedepot", inputUrl: postUrl, postUrl, resolvedUrl, canonicalProductUrl: resolvedUrl,
    rawTitle: candidate.rawTitle, imageUrl: candidate.imageUrl,
    currentPrice: candidate.currentPrice, oldPrice: candidate.oldPrice,
    homeDepot: { productId: identity.productId }
  };
}

export async function sourceHomeDepotWithSovrn(input: HomeDepotSovrnInput): Promise<HomeDepotSovrnDecision> {
  let identity: HomeDepotUrlIdentity;
  try { identity = homeDepotIdentityFromUrl(input.resolvedUrl); }
  catch (error) { return failed(error); }
  if (!input.provider) return failed(new ProductError("SOVRN_NOT_CONFIGURED", "extraction", "Home Depot product provider is unavailable"));
  let candidate;
  try {
    candidate = await input.provider.product({
      store: "homedepot", postUrl: input.postUrl,
      resolvedUrl: input.resolvedUrl, requestId: input.requestId
    });
  } catch (error) {
    const status = statusFor(error);
    const recordedCount = typeof (error as { sameRetailerOfferCount?: unknown })?.sameRetailerOfferCount === "number"
      ? (error as { sameRetailerOfferCount: number }).sameRetailerOfferCount : undefined;
    const sameRetailerOfferCount = recordedCount ?? (status === "NO_OFFER" || status === "NO_SAME_RETAILER" ? 0 : undefined);
    return failed(error, { sameRetailerOfferCount });
  }

  const common = { sameRetailerOfferCount: candidate.sameRetailerOfferCount };
  const currentPriceValid = candidate.product.currentPrice.currency === "USD" && candidate.product.currentPrice.value > 0;
  if (!currentPriceValid) return failed(new ProductError("SOVRN_INVALID_PRICE", "extraction", "Home Depot price is invalid"), common);
  const referencePriceStatus: HomeDepotReferenceStatus = candidate.referencePriceStatus ?? (candidate.product.oldPrice ? "VALID" : "ABSENT");
  try { await input.validateImage(candidate.product.imageUrl); }
  catch { return failed(new ProductError("SOVRN_INVALID_IMAGE", "extraction", "Home Depot image is invalid"), { ...common, currentPriceValid, referencePriceStatus }); }

  return {
    product: homeDepotProduct(identity, candidate.product, input.postUrl, input.resolvedUrl),
    telemetry: {
      event: "homedepot_sovrn_decision", sovrnStatus: "ACCEPTED", ...common,
      currentPriceValid: true, referencePriceStatus, sovrnImageValid: true, finalSource: "SOVRN_PRIMARY"
    }
  };
}
