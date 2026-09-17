import { ProductError } from "../../types";
import { validatePublicUrl } from "../safe-url";
import { hostnameMatches, sovrnMerchantAdapters } from "./merchant-registry";
import type { SovrnStoreId } from "./types";

const TRACKING_PARAMS = new Set([
  "affiliate", "afid", "affid", "aff_id", "affsource", "afsrc", "campaign", "campaignid", "clickid", "click_id",
  "cjevent", "irclickid", "irgwc", "iradid", "irpid", "linkid", "partner", "partnerid", "ranmid", "ranear",
  "raneaid", "ref", "ref_", "refid", "source", "subid", "tag", "utm_campaign", "utm_content", "utm_medium",
  "utm_source", "utm_term", "wickedid"
]);

export type SovrnLookupIdentity = { store: SovrnStoreId; plainlink: string; productIdentity: string };

export function buildSovrnPlainlink(value: string, store: SovrnStoreId): SovrnLookupIdentity {
  const url = validatePublicUrl(value);
  const adapter = sovrnMerchantAdapters[store];
  if (!adapter.domains.some(domain => hostnameMatches(url.hostname, domain))) {
    throw new ProductError("SOVRN_MERCHANT_MISMATCH", "url", "Resolved URL does not match the expected retailer");
  }
  const productIdentity = adapter.productIdentity(url);
  if (!productIdentity) throw new ProductError("SOVRN_PRODUCT_MISMATCH", "url", "Retailer product identity is unavailable");
  const keys: string[] = [];
  url.searchParams.forEach((_value, key) => { if (!keys.includes(key)) keys.push(key); });
  for (const key of keys) {
    const normalized = key.toLowerCase();
    if (TRACKING_PARAMS.has(normalized) || normalized.startsWith("utm_")) url.searchParams.delete(key);
  }
  url.hash = "";
  return { store, plainlink: url.href, productIdentity };
}
