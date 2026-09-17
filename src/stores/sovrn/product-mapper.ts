import { ProductError, type ProductData } from "../../types";
import { validatePublicUrl } from "../safe-url";
import { merchantMatchesStore, sovrnMerchantAdapters } from "./merchant-registry";
import type { SovrnMappedProduct, SovrnNormalizedOffer, SovrnReferenceSemantics, SovrnStoreId } from "./types";

const sameIdentity = (store: SovrnStoreId, expected: string, candidate: SovrnNormalizedOffer): boolean => {
  const values = [candidate.identity.merchantProductId, candidate.identity.barcode, candidate.identity.variantId];
  if (values.some(value => value?.toLowerCase() === expected.toLowerCase())) return true;
  if (!candidate.identity.normalizedPlainlink) return false;
  try { return sovrnMerchantAdapters[store].productIdentity(new URL(candidate.identity.normalizedPlainlink))?.toLowerCase() === expected.toLowerCase(); }
  catch { return false; }
};

export function mapSovrnProduct(input: {
  store: SovrnStoreId;
  postUrl: string;
  resolvedUrl: string;
  plainlink: string;
  productIdentity: string;
  offers: readonly SovrnNormalizedOffer[];
}): SovrnMappedProduct {
  const merchantOffers = input.offers.filter(offer => merchantMatchesStore(input.store, { name: offer.merchantName, domain: offer.merchantDomain }));
  if (!merchantOffers.length) throw new ProductError("SOVRN_MERCHANT_MISMATCH", "extraction", "Source retailer offer unavailable");
  const matches = merchantOffers.filter(offer => sameIdentity(input.store, input.productIdentity, offer));
  if (!matches.length) throw new ProductError("SOVRN_PRODUCT_MISMATCH", "extraction", "Exact source product unavailable");
  if (matches.length !== 1) throw new ProductError("SOVRN_AMBIGUOUS_OFFER", "extraction", "Source product offer is ambiguous");
  const offer = matches[0];
  if (offer.stockState === "out_of_stock") throw new ProductError("SOVRN_OUT_OF_STOCK", "extraction", "Source product is out of stock");
  const rawTitle = offer.title?.trim();
  if (!rawTitle) throw new ProductError("MISSING_TITLE", "extraction", "Sovrn title unavailable");
  if (!offer.currentPrice || !Number.isFinite(offer.currentPrice.value) || offer.currentPrice.value <= 0) throw new ProductError("SOVRN_MISSING_PRICE", "extraction", "Sovrn current price unavailable");
  let imageUrl: string;
  try { imageUrl = validatePublicUrl(offer.imageUrl ?? "").href; }
  catch { throw new ProductError("SOVRN_MISSING_IMAGE", "extraction", "Sovrn image unavailable"); }
  let oldPrice;
  let referenceSemantics: SovrnReferenceSemantics | undefined;
  if (offer.referencePrice && (offer.referenceSemantics === "was" || offer.referenceSemantics === "list") &&
      offer.referencePrice.currency === offer.currentPrice.currency && offer.referencePrice.value > offer.currentPrice.value) {
    oldPrice = offer.referencePrice;
    referenceSemantics = offer.referenceSemantics;
  }
  const product: ProductData = {
    store: input.store, inputUrl: input.postUrl, resolvedUrl: input.resolvedUrl,
    canonicalProductUrl: input.plainlink, postUrl: input.postUrl,
    rawTitle, imageUrl, currentPrice: offer.currentPrice, oldPrice
  };
  return { product, referenceSemantics, merchantGroupId: offer.merchantGroupId };
}

export function buildSovrnFacebookPost(product: ProductData, shortTitle: string, disclosure: string, semantics?: SovrnReferenceSemantics): string {
  const prefix = disclosure.trim() || "#Ad";
  const price = product.oldPrice && semantics === "list"
    ? `is now ${product.currentPrice.formatted}, list price ${product.oldPrice.formatted}.`
    : product.oldPrice && semantics === "was"
      ? `is now ${product.currentPrice.formatted}, was ${product.oldPrice.formatted}.`
      : `is now ${product.currentPrice.formatted}.`;
  return `${prefix} 🚨 ${shortTitle} ${price}\n\n👉 ${product.postUrl}`;
}
