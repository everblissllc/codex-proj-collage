import { jsonLdProducts, meta } from "./extractor";

export type WalmartHtmlDiagnostics = {
  canonicalProductId?: string;
  hasJsonLdProduct: boolean;
  hasNextData: boolean;
  hasOgTitle: boolean;
  hasStandardTitleOrProductMeta: boolean;
  challengeDetected: boolean;
};

export function walmartProductId(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== "walmart.com" && !parsed.hostname.endsWith(".walmart.com")) return undefined;
    return parsed.pathname.match(/\/ip\/(?:[^/]+\/)?(\d+)(?:\/|$)/i)?.[1];
  } catch {
    return undefined;
  }
}

function canonicalId(html: string, resolvedUrl: string): string | undefined {
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/\brel\s*=\s*["']canonical["']/i.test(tag)) continue;
    const href = tag.match(/\bhref\s*=\s*(["'])(.*?)\1/i)?.[2];
    if (!href) continue;
    try {
      const id = walmartProductId(new URL(href, resolvedUrl).href);
      if (id) return id;
    } catch { /* An invalid optional canonical URL supplies no product ID. */ }
  }
  return undefined;
}

export function inspectWalmartHtml(html: string, resolvedUrl: string): WalmartHtmlDiagnostics {
  const products = jsonLdProducts(html);
  const hasHtmlTitle = /<title\b[^>]*>\s*[^<\s][\s\S]*?<\/title>/i.test(html);
  const hasProductTitleMeta = Boolean(meta(html, "title")?.trim() || meta(html, "product:title")?.trim() || meta(html, "product:name")?.trim());
  const jsonLdProductId = products.map(product => {
    if (typeof product.url !== "string") return undefined;
    try { return walmartProductId(new URL(product.url, resolvedUrl).href); }
    catch { return undefined; }
  }).find(Boolean);
  return {
    canonicalProductId: canonicalId(html, resolvedUrl) ?? jsonLdProductId ?? walmartProductId(resolvedUrl),
    hasJsonLdProduct: products.length > 0,
    hasNextData: /<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["']/i.test(html),
    hasOgTitle: Boolean(meta(html, "og:title")?.trim()),
    hasStandardTitleOrProductMeta: hasHtmlTitle || hasProductTitleMeta,
    challengeDetected: /robot or human\?|press and hold|verify you(?:'re| are) (?:a )?human|px-captcha|perimeterx|challenge-platform|access denied/i.test(html)
  };
}
