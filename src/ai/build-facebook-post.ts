import type { ProductData } from "../types";

export function buildFacebookPost(product: ProductData, shortTitle: string, disclosure: string): string {
  const safeDisclosure = disclosure.trim() || "#Ad";
  const referencePrice = product.store === "amazon"
    ? product.amazon?.referencePriceType === "LIST_PRICE" ? product.oldPrice : undefined
    : product.oldPrice;
  const referenceLabel = product.store === "amazon" ? "list price" : "was";
  const priceSentence = referencePrice
    ? `is now ${product.currentPrice.formatted}, ${referenceLabel} ${referencePrice.formatted}.`
    : `is now ${product.currentPrice.formatted}.`;
  return `${safeDisclosure} 🚨 ${shortTitle} ${priceSentence}\n\n👉 ${product.postUrl}`;
}
