import type { Price, ProductData } from "../../types";

export type SovrnStoreId = "walmart" | "elf" | "target" | "nordstrom" | "ulta" | "sephora" | "ecosmetics" | "bubble";
export type SovrnMarket = "usd_en";
export type SovrnReferenceSemantics = "was" | "list";
export type SovrnStockState = "in_stock" | "out_of_stock" | "unknown";

export type SovrnClientConfig = {
  secretKey: string;
  siteApiKey: string;
  market: SovrnMarket;
  campaignId?: string;
};

export type SovrnIdentity = {
  normalizedPlainlink?: string;
  merchantProductId?: string;
  barcode?: string;
  variantId?: string;
};

// This is deliberately not the wire shape. A live sanitized shape pilot must establish
// the decoder from Sovrn's undocumented response before production integration.
export type SovrnNormalizedOffer = {
  merchantName?: string;
  merchantDomain?: string;
  merchantGroupId?: string | number;
  identity: SovrnIdentity;
  title?: string;
  imageUrl?: string;
  currentPrice?: Price;
  referencePrice?: Price;
  referenceSemantics?: SovrnReferenceSemantics;
  stockState: SovrnStockState;
};

export type SovrnMappedProduct = {
  product: ProductData;
  referenceSemantics?: SovrnReferenceSemantics;
  merchantGroupId?: string | number;
};

export type SovrnStructuralOffer = {
  keys: string[];
  fieldTypes: Record<string, string>;
  merchantIdentityFields: Record<string, string | number | boolean>;
  presence: {
    titleLike: boolean;
    imageLike: boolean;
    priceLike: boolean;
    stockLike: boolean;
    referencePriceLike: boolean;
    productIdentityLike: boolean;
  };
  candidateFields: Record<string, Array<{ path: string; type: string; value?: string | number | boolean; https?: boolean; hostname?: string; pathShape?: string }>>;
};

export type SovrnStructuralSummary = {
  topLevelType: string;
  topLevelKeys: string[];
  resultArrayPath?: string;
  resultCount: number;
  offers: SovrnStructuralOffer[];
};

export type SovrnPilotOfferSummary = {
  merchant: { name?: string; id?: string | number };
  name?: string;
  id?: string | number;
  salePrice?: number;
  retailPrice?: number;
  currency?: string;
  discountRate?: number;
  affiliatable?: boolean;
  deeplinkPresent: boolean;
  image: { present: boolean; https?: boolean; hostname?: string };
  thumbnail: { present: boolean; https?: boolean; hostname?: string };
  fieldTypes: Record<string, string>;
  stockFields: Array<{ path: string; type: string; value: string | number | boolean }>;
  strongerIdentityFields: Array<{ path: string; type: string; value: string | number | boolean }>;
};

export type SovrnPilotPriceSummary = {
  topLevelType: string;
  topLevelKeys: string[];
  resultCount: number;
  offers: SovrnPilotOfferSummary[];
};

export type SovrnApprovedMerchantFinding = {
  domain: string;
  found: boolean;
  approved: boolean;
  groupId?: string | number;
  statusFields: Array<{ path: string; value: string | number | boolean }>;
  identityFields: Array<{ path: string; value: string | number | boolean }>;
};
