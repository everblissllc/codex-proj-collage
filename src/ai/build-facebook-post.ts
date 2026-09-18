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

export function validFacebookHookTemplate(value: string, rawTitle?: string): boolean {
  if (!value || value.length > 220 || /https?:\/\/|www\.|#ad\b/i.test(value)) return false;
  if (/\d/.test(value)) return false;
  if (/\b(?:coupon|clearance|sale|off|discount|markdown|price drop|lowest price|sold out|few left|save|savings)\b/i.test(value)) return false;
  const withoutAllowed = value.replace(/{{(?:PRICE|SHORT_TITLE|RETAILER)}}/g, "");
  if (/{{|}}/.test(withoutAllowed)) return false;
  if (rawTitle === undefined) return true;
  const ageTerms = value.match(/\b(?:baby|babies|kid|kids|toddler|toddlers|child|children)\b/gi) ?? [];
  const source = rawTitle.toLowerCase();
  if (!ageTerms.every(term => source.includes(term.toLowerCase()))) return false;
  if (/\blittle ones?\b/i.test(value) && !/\b(?:baby|babies|kid|kids|toddler|toddlers|child|children|toy|toys)\b/i.test(source)) return false;
  return true;
}

function safeFacebookPost(value: string, product: ProductData, shortTitle: string): boolean {
  if (!value || value.length > 256 || /#ad\b|https?:\/\/|www\./i.test(value) || /{{|}}/.test(value)) return false;
  if (product.oldPrice?.formatted && product.oldPrice.formatted !== product.currentPrice.formatted && value.includes(product.oldPrice.formatted)) return false;
  if (product.amazon?.savings?.percentage !== undefined && value.includes(`${product.amazon.savings.percentage}%`)) return false;
  if (product.amazon?.asin && value.toUpperCase().includes(product.amazon.asin.toUpperCase())) return false;
  if (/\b(?:coupon|clearance|sale|list price|was|off|discount|markdown|price drop|lowest price|sold out|few left|save|savings)\b|\d+\s*%\s*off\b/i.test(value)) return false;
  const withoutTrustedValues = value
    .replaceAll(product.currentPrice.formatted, "")
    .replaceAll(shortTitle, "")
    .replaceAll(RETAILERS[product.store], "");
  return !/\d|\$|\b(?:usd|cad|eur|gbp)\b/i.test(withoutTrustedValues);
}

export function buildFacebookPost(product: ProductData, shortTitle: string, hookTemplate?: string): string {
  const safeHook = hookTemplate && validFacebookHookTemplate(hookTemplate, product.rawTitle) ? hookTemplate : undefined;
  for (const template of [safeHook, FALLBACK_WITH_TITLE, FALLBACK_GENERIC]) {
    if (!template) continue;
    const post = substitute(template, product, shortTitle);
    if (safeFacebookPost(post, product, shortTitle)) return post;
  }
  throw new Error("Unable to build safe Facebook post");
}

export function buildFacebookComment(product: ProductData): string {
  return `#Ad\n\nComment “Deal” 👇❤️\nSo you don’t miss any of our latest finds! 🎉\n✔️See it here: 👉 ${product.postUrl}`;
}
