import type { StoreId } from "../types";

export function detectStore(url: string): StoreId | undefined {
  let hostname: string;
  try { hostname = new URL(url).hostname.toLowerCase(); } catch { return undefined; }
  const on = (domain: string) => hostname === domain || hostname.endsWith(`.${domain}`);
  if (on("walmart.com")) return "walmart";
  if (on("elfcosmetics.com")) return "elf";
  if (on("hellobubble.com")) return "bubble";
  if (on("amazon.com") || on("amzn.to")) return "amazon";
  if (on("target.com")) return "target";
  if (on("homedepot.com")) return "homedepot";
  return undefined;
}
