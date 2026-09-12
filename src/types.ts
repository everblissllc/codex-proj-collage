export type StoreId = "walmart" | "amazon" | "target" | "homedepot";
export type Price = { value: number; formatted: string; currency: string };
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
};
export type GeneratedContent = { shortTitle: string; facebookPost: string };
export type CopyDraft = { shortTitle: string };

export class ProductError extends Error {
  constructor(public readonly code: string, public readonly stage: string, message: string, public readonly validationReason?: string) {
    super(message);
    this.name = "ProductError";
  }
}
