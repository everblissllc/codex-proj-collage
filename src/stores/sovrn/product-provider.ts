import { ProductError, type Price, type ProductData } from "../../types";
import { validatePublicUrl } from "../safe-url";
import { SovrnClient } from "./client";
import { assessSovrnIdentity, inspectSovrnSource } from "./source-identity";
import { buildSovrnPlainlink } from "./plainlink";
import { merchantMatchesStore } from "./merchant-registry";
import type { SovrnIdentityAssessment, SovrnProductInput, SovrnProductProvider, SovrnProductResult, SovrnWireOffer } from "./types";
import { decodeSovrnOffers } from "./wire";

const formatMoney = (value: number, currency: string): Price => ({
  value,
  currency,
  formatted: new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value)
});

function usableImage(value: string | undefined): string {
  try {
    const url = validatePublicUrl(value ?? "");
    if (url.protocol !== "https:") throw new Error("HTTPS required");
    return url.href;
  } catch { throw new ProductError("SOVRN_INVALID_IMAGE", "extraction", "Sovrn image URL is invalid"); }
}

function identityFailure(assessments: readonly SovrnIdentityAssessment[]): ProductError {
  if (assessments.some(item => item.variantClassification === "VARIANT_CONFLICT")) {
    return new ProductError("SOVRN_VARIANT_CONFLICT", "extraction", "Sovrn offer conflicts with the submitted variant");
  }
  if (assessments.some(item => item.variantClassification === "VARIANT_AMBIGUOUS_HIGH_RISK")) {
    return new ProductError("SOVRN_VARIANT_AMBIGUOUS", "extraction", "Sovrn offer variant is ambiguous");
  }
  return new ProductError("SOVRN_PRODUCT_MISMATCH", "extraction", "Sovrn offer does not match the submitted product");
}

function mapProduct(input: SovrnProductInput, plainlink: string, offer: SovrnWireOffer): ProductData {
  const title = offer.title?.trim();
  if (!title) throw new ProductError("SOVRN_PRODUCT_MISMATCH", "extraction", "Sovrn title is unavailable");
  if (!Number.isFinite(offer.salePrice) || offer.salePrice! <= 0 || offer.currency !== "USD") {
    throw new ProductError("SOVRN_INVALID_PRICE", "extraction", "Sovrn current price is invalid");
  }
  if (offer.stockState === "out_of_stock") throw new ProductError("SOVRN_PRODUCT_MISMATCH", "extraction", "Sovrn source offer is out of stock");
  const currentPrice = formatMoney(offer.salePrice!, offer.currency);
  const oldPrice = Number.isFinite(offer.retailPrice) && offer.retailPrice! > currentPrice.value
    ? formatMoney(offer.retailPrice!, offer.currency)
    : undefined;
  return {
    store: input.store,
    inputUrl: input.postUrl,
    postUrl: input.postUrl,
    resolvedUrl: input.resolvedUrl,
    canonicalProductUrl: plainlink,
    rawTitle: title,
    imageUrl: usableImage(offer.imageUrl),
    currentPrice,
    oldPrice
  };
}

export class PriceComparisonSovrnProductProvider implements SovrnProductProvider {
  constructor(private readonly client: SovrnClient) {}

  async product(input: SovrnProductInput): Promise<SovrnProductResult> {
    const lookup = buildSovrnPlainlink(input.resolvedUrl, input.store);
    const source = inspectSovrnSource({
      store: input.store,
      sourceProduct: input.sourceProduct,
      postUrl: input.postUrl,
      resolvedUrl: input.resolvedUrl,
      html: input.sourceHtml
    });
    const response = await this.client.compareByPlainlinkDetailed({ plainlink: lookup.plainlink, store: input.store, requestId: input.requestId });
    const offers = decodeSovrnOffers(response.value);
    if (!offers.length) throw new ProductError("SOVRN_NO_OFFER_FOR_PLAINLINK", "extraction", "Sovrn returned no offer for this product URL");
    const sameRetailer = offers.filter(offer => input.store === "homedepot"
      ? offer.merchantName.trim().toLowerCase() === "the home depot"
      : merchantMatchesStore(input.store, offer.merchantName));
    if (!sameRetailer.length) throw new ProductError("SOVRN_NO_SAME_RETAILER_OFFER", "extraction", "Sovrn returned no source-retailer offer");
    if (!source.productIdConfirmed || !source.productNames.length) {
      throw new ProductError("SOVRN_SOURCE_IDENTITY_UNAVAILABLE", "extraction", "Current source product identity is unavailable");
    }
    const assessed = sameRetailer.map(offer => ({ offer, identity: assessSovrnIdentity(source, offer) }));
    const identityMatches = assessed.filter(({ identity }) => identity.productMatchConfirmed &&
      ["EXACT_VARIANT_MATCH", "NO_VARIANT_CONFLICT"].includes(identity.variantClassification));
    if (!identityMatches.length) throw identityFailure(assessed.map(item => item.identity));
    const affiliatable = identityMatches.filter(({ offer }) => offer.affiliatable === true);
    if (!affiliatable.length) throw new ProductError("SOVRN_NO_SAME_RETAILER_OFFER", "extraction", "Sovrn source-retailer offer is not affiliatable");
    if (affiliatable.length !== 1) throw new ProductError("SOVRN_PRODUCT_MISMATCH", "extraction", "Sovrn source-retailer offer is ambiguous");
    const selected = affiliatable[0];
    const product = mapProduct(input, lookup.plainlink, selected.offer);
    console.log(JSON.stringify({
      event: "sovrn_offer_selected", requestId: input.requestId, store: input.store,
      merchant: selected.offer.merchantName, hasTitle: true, hasImage: true, hasCurrentPrice: true,
      hasReferencePrice: Boolean(product.oldPrice), stockState: selected.offer.stockState,
      variantClassification: selected.identity.variantClassification
    }));
    return { product, identity: selected.identity, merchantId: selected.offer.merchantId };
  }
}
