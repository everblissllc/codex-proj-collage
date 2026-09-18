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
    productIdentity: url => pathMatch(url, /\/ip\/(?:[^/]+\/)?(\d+)(?:\/|$)/i), productSignificantParams: ["selectedsellerid"]
  }
};

export function sovrnStoreForHostname(hostname: string): SovrnStoreId | undefined {
  return (Object.values(sovrnMerchantAdapters) as SovrnMerchantAdapter[])
    .find(adapter => adapter.domains.some(domain => hostnameMatches(hostname, domain)))?.store;
}
export function merchantMatchesStore(store: SovrnStoreId, merchantName: string): boolean {
  const name = lower(merchantName);
  return Boolean(name && sovrnMerchantAdapters[store].merchantNames.some(candidate => lower(candidate) === name));
}
