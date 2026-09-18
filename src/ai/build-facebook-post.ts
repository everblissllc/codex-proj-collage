import type { ProductData } from "../types";

const FALLBACK_WITH_TITLE = "omggg {{SHORT_TITLE}} for {{PRICE}}?! this is such a good find 👀🔥\nLink in Comment !! 🔗⬇️";
const FALLBACK_GENERIC = "omggg {{PRICE}}?! this is such a good find 👀🔥\nLink in Comment !! 🔗⬇️";

const RETAILERS: Record<ProductData["store"], string> = {
  walmart: "Walmart", amazon: "Amazon", elf: "e.l.f.", target: "Target", homedepot: "The Home Depot"
};

function substitute(template: string, product: ProductData, shortTitle: string): string {
  return template
    .replaceAll("{{PRICE}}", product.currentPrice.formatted)
    .replaceAll("{{SHORT_TITLE}}", shortTitle)
    .replaceAll("{{RETAILER}}", RETAILERS[product.store]);
}

function safeFacebookPost(value: string, product: ProductData): boolean {
  if (!value || value.length > 256 || /#ad\b|https?:\/\/|www\./i.test(value) || /{{|}}/.test(value)) return false;
  if (!value.includes(product.currentPrice.formatted)) return false;
  if (product.oldPrice?.formatted && product.oldPrice.formatted !== product.currentPrice.formatted && value.includes(product.oldPrice.formatted)) return false;
  if (product.amazon?.savings?.percentage !== undefined && value.includes(`${product.amazon.savings.percentage}%`)) return false;
  if (product.amazon?.asin && value.toUpperCase().includes(product.amazon.asin.toUpperCase())) return false;
  if (/\b(?:coupon|clearance|sale|list price|was|off|discount|markdown|price drop|lowest price|sold out|few left|save|savings)\b|\d+\s*%\s*off\b/i.test(value)) return false;
  const withoutTrustedPrice = value.replace(product.currentPrice.formatted, "");
  return !/\$\s*\d|\b\d+(?:\.\d{1,2})?\s*(?:usd|cad|eur|gbp)\b/i.test(withoutTrustedPrice);
}

export function buildFacebookPost(product: ProductData, shortTitle: string, hookTemplate?: string): string {
  for (const template of [hookTemplate, FALLBACK_WITH_TITLE, FALLBACK_GENERIC]) {
    if (!template) continue;
    const post = substitute(template, product, shortTitle);
    if (safeFacebookPost(post, product)) return post;
  }
  throw new Error("Unable to build safe Facebook post");
}

export function buildFacebookComment(product: ProductData): string {
  return `#Ad\n\nComment “Deal” 👇❤️\nSo you don’t miss any of our latest finds! 🎉\n✔️See it here: 👉 ${product.postUrl}`;
}
