import { ProductError, type AmazonProductMetadata, type Price, type ProductData } from "../../types";
import { validatePublicUrl } from "../safe-url";
import type { CreatorsItem, CreatorsListing, CreatorsMoney } from "./creators-api-types";
import type { AmazonCreatorsApiClient } from "./creators-api-client";

export interface AmazonProductProvider {
  product(asin: string, inputUrl: string, resolvedUrl: string, requestId?: string): Promise<ProductData>;
}

function normalized(value: string | undefined): string { return (value ?? "").replace(/[^a-z0-9]/gi, "").toUpperCase(); }
function money(value: CreatorsMoney | undefined): Price | undefined {
  if (!value || typeof value.amount !== "number" || !Number.isFinite(value.amount) || value.amount <= 0 || typeof value.currency !== "string" || !/^[A-Z]{3}$/.test(value.currency)) return undefined;
  const formatted = typeof value.displayAmount === "string" && value.displayAmount.trim() ? value.displayAmount.trim() : undefined;
  if (!formatted) return undefined;
  return { value: value.amount, formatted, currency: value.currency };
}
function listingSafe(listing: CreatorsListing): boolean {
  const availability = normalized(listing.availability?.type);
  const condition = normalized(listing.condition?.value);
  const type = normalized(listing.type);
  const access = normalized(listing.dealDetails?.accessType);
  return ["INSTOCK", "INSTOCKSCARCE"].includes(availability) && condition === "NEW" &&
    type !== "SUBSCRIBEANDSAVE" && (!type || type === "LIGHTNINGDEAL") &&
    (!access || access === "ALL") && listing.violatesMAP !== true && Boolean(money(listing.price?.money));
}
function selectListing(listings: CreatorsListing[]): CreatorsListing {
  const safe = listings.filter(listingSafe);
  const winners = safe.filter(listing => listing.isBuyBoxWinner === true);
  if (winners.length === 1) return winners[0];
  if (winners.length > 1) throw new ProductError("AMAZON_NO_PURCHASABLE_OFFER", "extraction", "Amazon featured offer is ambiguous");
  const unspecified = safe.filter(listing => listing.isBuyBoxWinner === undefined);
  if (unspecified.length === 1) return unspecified[0];
  throw new ProductError("AMAZON_NO_PURCHASABLE_OFFER", "extraction", "No safe Amazon featured offer");
}
function allowedAmazonUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = validatePublicUrl(value);
    if (url.protocol !== "https:" || (url.hostname !== "amazon.com" && !url.hostname.endsWith(".amazon.com"))) return undefined;
    return url.href;
  } catch { return undefined; }
}
function imageUrl(value: string | undefined): string {
  if (!value) throw new ProductError("MISSING_IMAGE", "extraction", "Creators API primary image missing");
  try {
    const url = validatePublicUrl(value);
    if (url.protocol !== "https:") throw new Error("not https");
    return url.href;
  } catch { throw new ProductError("MISSING_IMAGE", "extraction", "Creators API primary image invalid"); }
}

export function mapCreatorsItem(item: CreatorsItem, requestedAsin: string, inputUrl: string, resolvedUrl: string): ProductData {
  if (item.asin?.toUpperCase() !== requestedAsin) throw new ProductError("AMAZON_ASIN_MISMATCH", "extraction", "Creators API returned another ASIN");
  const rawTitle = item.itemInfo?.title?.displayValue?.trim();
  if (!rawTitle) throw new ProductError("MISSING_TITLE", "extraction", "Creators API title missing");
  const primaryImage = imageUrl(item.images?.primary?.large?.url);
  const listing = selectListing(item.offersV2?.listings ?? []);
  const currentPrice = money(listing.price?.money);
  if (!currentPrice) throw new ProductError("AMAZON_NO_PURCHASABLE_OFFER", "extraction", "Creators API current price missing");
  const basis = money(listing.price?.savingBasis?.money);
  const basisTypeRaw = listing.price?.savingBasis?.savingBasisType;
  const basisType = normalized(basisTypeRaw);
  const referencePriceType = basisType === "WASPRICE" ? "WAS_PRICE" : basisType === "LISTPRICE" ? "LIST_PRICE" : undefined;
  const oldPrice = referencePriceType && basis && basis.currency === currentPrice.currency && basis.value > currentPrice.value ? basis : undefined;
  const savingsMoney = money(listing.price?.savings?.money);
  const amazon: AmazonProductMetadata = {
    asin: requestedAsin,
    referencePriceType: oldPrice ? referencePriceType : undefined,
    savingBasisType: basisTypeRaw,
    savings: savingsMoney || Number.isFinite(listing.price?.savings?.percentage)
      ? { money: savingsMoney, percentage: listing.price?.savings?.percentage }
      : undefined,
    dealDetails: listing.dealDetails ? {
      accessType: listing.dealDetails.accessType,
      badge: listing.dealDetails.badge,
      startTime: listing.dealDetails.startTime,
      endTime: listing.dealDetails.endTime
    } : undefined,
    availability: listing.availability?.type ?? "UNKNOWN",
    condition: listing.condition?.value ?? "Unknown",
    listingType: listing.type,
    isBuyBoxWinner: listing.isBuyBoxWinner,
    merchant: listing.merchantInfo
  };
  return {
    store: "amazon", inputUrl, postUrl: inputUrl, resolvedUrl,
    canonicalProductUrl: allowedAmazonUrl(item.detailPageURL), rawTitle, imageUrl: primaryImage,
    currentPrice, oldPrice, amazon
  };
}

export class CreatorsAmazonProductProvider implements AmazonProductProvider {
  constructor(private readonly client: AmazonCreatorsApiClient) {}
  async product(asin: string, inputUrl: string, resolvedUrl: string, requestId?: string): Promise<ProductData> {
    const item = await this.client.getItem(asin, requestId);
    let product: ProductData;
    try { product = mapCreatorsItem(item, asin, inputUrl, resolvedUrl); }
    catch (error) {
      console.warn(JSON.stringify({ event: "amazon_offer_rejected", requestId, asin, errorCode: error instanceof ProductError ? error.code : "AMAZON_CREATORS_API_ERROR" }));
      throw error;
    }
    console.log(JSON.stringify({
      event: "amazon_offer_selected", requestId, asin,
      hasTitle: true, hasImage: true, hasCurrentPrice: true, hasSavingBasis: Boolean(product.amazon?.savingBasisType),
      savingBasisType: product.amazon?.savingBasisType, hasDealDetails: Boolean(product.amazon?.dealDetails),
      availability: product.amazon?.availability, listingType: product.amazon?.listingType,
      condition: product.amazon?.condition, buyBox: product.amazon?.isBuyBoxWinner
    }));
    return product;
  }
}
