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
