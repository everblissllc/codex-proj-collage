import type { ProductData } from "../../types";
import type { HomeDepotProductEvidence } from "../homedepot/extractor";

export type SovrnStoreId = "walmart" | "homedepot";
export type SovrnMarket = "usd_en";
export type SovrnVariantClassification =
  | "EXACT_VARIANT_MATCH"
  | "NO_VARIANT_CONFLICT"
  | "VARIANT_CONFLICT"
  | "VARIANT_AMBIGUOUS_HIGH_RISK";

export type SovrnClientConfig = { secretKey: string; siteApiKey: string; market: SovrnMarket };
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

export type SovrnSourceEvidence = {
  store: SovrnStoreId;
  productId?: string;
  productIdConfirmed: boolean;
  productNames: string[];
  variant: SovrnVariantEvidence;
  homeDepot?: HomeDepotProductEvidence;
};

export type SovrnWireOffer = {
  merchantName: string;
  merchantId?: string | number;
  title?: string;
  offerId?: string | number;
  salePrice?: number;
  retailPrice?: number;
  currency?: string;
  discountRate?: number;
  affiliatable?: boolean;
  imageUrl?: string;
  thumbnailUrl?: string;
  stockState: "in_stock" | "out_of_stock" | "unknown";
  identity: { barcode?: string; gtin?: string; upc?: string; ean?: string; sku?: string; mpn?: string; productId?: string };
};

export type SovrnIdentityAssessment = {
  productMatchConfirmed: boolean;
  variantClassification: SovrnVariantClassification;
  sourceVariant: SovrnVariantEvidence;
  offerVariant: SovrnVariantEvidence;
};

export type SovrnProductResult = { product: ProductData; identity: SovrnIdentityAssessment; merchantId?: string | number };

export type SovrnProductInput = {
  store: SovrnStoreId;
  sourceProduct: ProductData;
  postUrl: string;
  resolvedUrl: string;
  sourceHtml: string;
  requestId?: string;
};

export interface SovrnProductProvider {
  product(input: SovrnProductInput): Promise<SovrnProductResult>;
}
