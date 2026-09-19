import type { SovrnStoreId } from "./types";

export type SovrnMerchantAdapter = {
  store: SovrnStoreId;
  domains: readonly string[];
  merchantNames: readonly string[];
  productIdentity(url: URL): string | undefined;
  productSignificantParams: readonly string[];
};

const lower = (value: string): string => value.trim().toLowerCase();
export const hostnameMatches = (hostname: string, domain: string): boolean => {
  const host = lower(hostname).replace(/\.$/, "");
  const allowed = lower(domain);
  return host === allowed || host.endsWith(`.${allowed}`);
};

const pathMatch = (url: URL, pattern: RegExp): string | undefined => url.pathname.match(pattern)?.[1];

export const sovrnMerchantAdapters: Readonly<Record<SovrnStoreId, SovrnMerchantAdapter>> = {
  walmart: {
    store: "walmart", domains: ["walmart.com"], merchantNames: ["walmart", "walmart.com"],
    productIdentity: url => pathMatch(url, /\/ip\/(?:[^/]+\/)?(\d+)(?:\/|$)/i),
    productSignificantParams: ["selectedsellerid"]
  },
  elf: {
    store: "elf", domains: ["elfcosmetics.com"], merchantNames: ["e.l.f.", "e.l.f. cosmetics", "elf cosmetics", "elfcosmetics.com"],
    productIdentity: url => pathMatch(url, /\/products?\/([^/?#]+)/i),
    productSignificantParams: ["variant", "shade", "color"]
  },
  target: {
    store: "target", domains: ["target.com"], merchantNames: ["target", "target.com"],
    productIdentity: url => pathMatch(url, /\/A-(\d+)(?:\/|$)/i),
    productSignificantParams: ["preselect", "preselectchild"]
  },
  homedepot: {
    store: "homedepot", domains: ["homedepot.com"], merchantNames: ["the home depot", "home depot", "homedepot.com"],
    productIdentity: url => pathMatch(url, /\/p\/(?:[^/]+\/)?(\d+)(?:\/)?$/i),
    productSignificantParams: []
  },
  nordstrom: {
    store: "nordstrom", domains: ["nordstrom.com"], merchantNames: ["nordstrom", "nordstrom.com"],
    productIdentity: url => pathMatch(url, /\/s\/(?:[^/]+\/)?(\d+)(?:\/|$)/i),
    productSignificantParams: ["color", "size"]
  },
  ulta: {
    store: "ulta", domains: ["ulta.com"], merchantNames: ["ulta beauty", "ulta", "ulta.com"],
    productIdentity: url => url.searchParams.get("productId") ?? pathMatch(url, /\/p\/[^/]*?(?:-|\/)(pimprod\d+)(?:\/|$)/i),
    productSignificantParams: ["productid", "sku"]
  },
  sephora: {
    store: "sephora", domains: ["sephora.com"], merchantNames: ["sephora", "sephora.com"],
    productIdentity: url => pathMatch(url, /-(P\d+)(?:\/|$)/i),
    productSignificantParams: ["skuid"]
  },
  ecosmetics: {
    store: "ecosmetics", domains: ["ecosmetics.com"], merchantNames: ["ecosmetics", "ecosmetics.com", "eCosmetics"],
    productIdentity: url => pathMatch(url, /\/product\/([^/?#]+)/i),
    productSignificantParams: ["variant", "attribute_pa_olaplex_size"]
  },
  bubble: {
    store: "bubble", domains: ["hellobubble.com"], merchantNames: ["bubble", "hellobubble", "hellobubble.com"],
    productIdentity: url => pathMatch(url, /\/products\/([^/?#]+)/i),
    productSignificantParams: ["variant"]
  }
};

export function sovrnStoreForHostname(hostname: string): SovrnStoreId | undefined {
  return (Object.values(sovrnMerchantAdapters) as SovrnMerchantAdapter[])
    .find(adapter => adapter.domains.some(domain => hostnameMatches(hostname, domain)))?.store;
}

export function merchantMatchesStore(store: SovrnStoreId, merchant: { name?: string; domain?: string }): boolean {
  const adapter = sovrnMerchantAdapters[store];
  const merchantDomain = merchant.domain;
  if (merchantDomain && adapter.domains.some(domain => hostnameMatches(merchantDomain, domain))) return true;
  const merchantName = merchant.name;
  const name = merchantName ? lower(merchantName) : "";
  return Boolean(name && adapter.merchantNames.some(candidate => lower(candidate) === name));
}
