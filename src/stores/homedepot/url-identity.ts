import { ProductError } from "../../types";
import { hostnameMatches } from "../sovrn/merchant-registry";

export type HomeDepotUrlIdentity = {
  productId: string;
  productIdConfirmed: true;
};

export function homeDepotIdentityFromUrl(value: string): HomeDepotUrlIdentity {
  const url = new URL(value);
  if (!hostnameMatches(url.hostname, "homedepot.com")) throw new ProductError("HOME_DEPOT_IDENTITY_UNAVAILABLE", "url", "Resolved Home Depot host is invalid");
  const match = url.pathname.match(/^\/p\/([^/]+)\/(\d+)\/?$/i);
  if (!match) throw new ProductError("HOME_DEPOT_IDENTITY_UNAVAILABLE", "url", "Home Depot product URL identity is unavailable");
  return { productId: match[2], productIdConfirmed: true };
}
