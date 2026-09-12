import type { CopyProvider } from "./provider";
import { ProductError, type GeneratedContent, type ProductData } from "../types";

export async function generateProductCopy(product: ProductData, provider: CopyProvider, disclosure = "#Ad"): Promise<GeneratedContent> {
  let draft;
  try { draft = await provider.generate(product); }
  catch (error) {
    if (error instanceof ProductError) throw error;
    throw new ProductError("AI_PROVIDER_FAILED", "ai", String(error));
  }
  const prices = [...draft.facebookBody.matchAll(/\$\s?\d[\d,]*(?:\.\d{2})?/g)].map(match => match[0].replace(/\s/g, ""));
  const allowed = [product.currentPrice.formatted, product.oldPrice?.formatted].filter(Boolean);
  if (!draft.facebookBody.includes(product.currentPrice.formatted) ||
      (product.oldPrice && !draft.facebookBody.includes(product.oldPrice.formatted)) ||
      prices.some(price => !allowed.includes(price)) ||
      /\b(only \d+ left|limited stock|lowest price ever|expires? (today|tonight)|\d+% off)\b/i.test(draft.facebookBody)) {
    throw new ProductError("AI_INVALID_CONTENT", "ai", "AI body has missing or unsupported claims");
  }
  const safeDisclosure = disclosure.trim() || "#Ad";
  return {
    shortTitle: draft.shortTitle,
    facebookPost: `${safeDisclosure} 🚨 ${draft.facebookBody}\n\n👉 ${product.postUrl}`
  };
}
