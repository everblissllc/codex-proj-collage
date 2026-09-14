import type { ProductData } from "../types";

export function buildFacebookPost(product: ProductData, shortTitle: string, disclosure: string): string {
  const safeDisclosure = disclosure.trim() || "#Ad";
  const priceSentence = product.oldPrice
    ? `is now ${product.currentPrice.formatted}, was ${product.oldPrice.formatted}.`
    : `is now ${product.currentPrice.formatted}.`;
  return `${safeDisclosure} 🚨 ${shortTitle} ${priceSentence}\n\n👉 ${product.postUrl}`;
}
