export type StoreId = "walmart" | "elf" | "amazon" | "target" | "homedepot";
export type Price = { value: number; formatted: string; currency: string };
export type AmazonProductMetadata = {
  asin: string;
  referencePriceType?: "LIST_PRICE";
  savingBasisType?: string;
  savings?: { money?: Price; percentage?: number };
  dealDetails?: { accessType?: string; badge?: string; startTime?: string; endTime?: string };
  availability: string;
  condition: string;
  listingType?: string;
  isBuyBoxWinner?: boolean;
  merchant?: { id?: string; name?: string };
};
export type HomeDepotProductMetadata = {
  productId: string;
  model: string;
  brand?: string;
  productFamily?: string;
  color?: string;
  dimensions?: { width: number; height: number; depth: number; unit: "in" };
  construction?: { gauge?: number; material?: string };
  mounting?: string;
  packCount?: number;
};
export type ProductData = {
  store: StoreId;
  inputUrl: string;
  resolvedUrl: string;
  canonicalProductUrl?: string;
  postUrl: string;
  rawTitle: string;
  imageUrl: string;
  currentPrice: Price;
  oldPrice?: Price;
  amazon?: AmazonProductMetadata;
  homeDepot?: HomeDepotProductMetadata;
};
export type GeneratedContent = { shortTitle: string; facebookPost: string; facebookComment: string };
export type CopyDraft = { shortTitle: string; facebookHookTemplate?: string };
export type BrowserDiagnostics = {
  browserStatus?: number;
  browserStatusText?: string;
  browserDurationMs: number;
  browserMsUsed?: number;
  browserReason: string;
};

export class ProductError extends Error {
  constructor(public readonly code: string, public readonly stage: string, message: string, public readonly validationReason?: string, public readonly browserDiagnostics?: BrowserDiagnostics) {
    super(message);
    this.name = "ProductError";
  }
}
