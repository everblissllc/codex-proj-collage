import type { ProductData } from "../types";

export function buildFacebookPost(product: ProductData, shortTitle: string, disclosure: string): string {
  const safeDisclosure = disclosure.trim() || "#Ad";
  const referenceLabel = product.store === "amazon" && product.amazon?.referencePriceType === "LIST_PRICE" ? "list price" : "was";
  const priceSentence = product.oldPrice
    ? `is now ${product.currentPrice.formatted}, ${referenceLabel} ${product.oldPrice.formatted}.`
    : `is now ${product.currentPrice.formatted}.`;
  return `${safeDisclosure} 🚨 ${shortTitle} ${priceSentence}\n\n👉 ${product.postUrl}`;
}
