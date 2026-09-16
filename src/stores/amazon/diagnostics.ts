import { jsonLdProducts, meta } from "../walmart/extractor";

export type AmazonHtmlDiagnostics = {
  canonicalAsin?: string;
  pageAsinDetected: boolean;
  challengeDetected: boolean;
  hasJsonLdProduct: boolean;
  hasStructuredOfferPrice: boolean;
  hasPurchasableStructuredOffer: boolean;
  hasProductTitle: boolean;
  hasProductImage: boolean;
  hasPrimaryPrice: boolean;
  hasPurchaseOffer: boolean;
};

function records(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) return value.flatMap(records);
  return value && typeof value === "object" ? [value as Record<string, unknown>] : [];
}

function structuredOffer(product: Record<string, unknown>): { priced: boolean; purchasable: boolean } {
  const offers = records(product.offers);
  return {
    priced: offers.some(offer => offer.price !== undefined || offer.lowPrice !== undefined),
    purchasable: offers.some(offer => {
      const condition = typeof offer.itemCondition === "string" ? offer.itemCondition.toLowerCase() : "";
      const availability = typeof offer.availability === "string" ? offer.availability.toLowerCase() : "";
      return (!condition || condition.endsWith("newcondition")) &&
        !/(?:outofstock|soldout|discontinued)/.test(availability) &&
        /(?:instock|limitedavailability|onlineonly|preorder|presale|backorder)/.test(availability);
    })
  };
}

export function validAsin(value: string | undefined): value is string {
  return typeof value === "string" && /^[A-Z0-9]{10}$/.test(value);
}

export function amazonAsinFromUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host !== "amazon.com" && !host.endsWith(".amazon.com")) return undefined;
    const match = url.pathname.match(/\/(?:dp|gp\/product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
    const asin = match?.[1].toUpperCase();
    return validAsin(asin) ? asin : undefined;
  } catch { return undefined; }
}

function canonicalUrl(html: string, resolvedUrl: string): string | undefined {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']canonical["']/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!href) continue;
    try { return new URL(href, resolvedUrl).href; } catch { /* Optional source. */ }
  }
  return undefined;
}

function hiddenAsin(html: string): string | undefined {
  for (const tag of html.match(/<input\b[^>]*>/gi) ?? []) {
    if (!/\b(?:id|name)\s*=\s*["']ASIN["']/i.test(tag)) continue;
    const value = tag.match(/\bvalue\s*=\s*(["'])([A-Z0-9]{10})\1/i)?.[2]?.toUpperCase();
    if (validAsin(value)) return value;
  }
  return undefined;
}

export function inspectAmazonHtml(html: string, resolvedUrl: string): AmazonHtmlDiagnostics {
  const urlAsin = amazonAsinFromUrl(resolvedUrl);
  const canonicalAsin = amazonAsinFromUrl(canonicalUrl(html, resolvedUrl));
  const inputAsin = hiddenAsin(html);
  const pageAsin = inputAsin ?? canonicalAsin;
  const products = jsonLdProducts(html);
  const structured = products.map(structuredOffer);
  return {
    canonicalAsin: pageAsin ?? urlAsin,
    pageAsinDetected: Boolean(pageAsin),
    challengeDetected: /sorry, we just need to make sure you(?:'re| are) not a robot|enter the characters you see below|api-services-support@amazon\.com|automated access to amazon data|\bcaptcha\b/i.test(html),
    hasJsonLdProduct: products.length > 0,
    hasStructuredOfferPrice: structured.some(value => value.priced),
    hasPurchasableStructuredOffer: structured.some(value => value.priced && value.purchasable),
    hasProductTitle: products.some(product => typeof product.name === "string" && product.name.trim().length > 0) || /\bid\s*=\s*["']productTitle["']/i.test(html) || Boolean(meta(html, "og:title")?.trim()),
    hasProductImage: products.some(product => Boolean(product.image)) || /\bid\s*=\s*["'](?:landingImage|imgTagWrapperId)["']/i.test(html) || Boolean(meta(html, "og:image")?.trim()),
    hasPrimaryPrice: /\bid\s*=\s*["'](?:corePrice|apex_desktop|priceblock_)[^"']*["']/i.test(html) || /\bclass\s*=\s*["'][^"']*priceToPay[^"']*["']/i.test(html) || Boolean(meta(html, "product:price:amount")?.trim()),
    hasPurchaseOffer: /\bid\s*=\s*["'](?:buybox|desktop_buybox|add-to-cart-button)["']/i.test(html) || /\bname\s*=\s*["']submit\.add-to-cart["']/i.test(html)
  };
}

export function usableAmazonHtml(diagnostics: AmazonHtmlDiagnostics): boolean {
  return !diagnostics.challengeDetected && Boolean(
    diagnostics.canonicalAsin && diagnostics.pageAsinDetected &&
    diagnostics.hasProductTitle &&
    diagnostics.hasProductImage &&
    ((diagnostics.hasPrimaryPrice && diagnostics.hasPurchaseOffer) ||
      (diagnostics.hasStructuredOfferPrice && diagnostics.hasPurchasableStructuredOffer))
  );
}
