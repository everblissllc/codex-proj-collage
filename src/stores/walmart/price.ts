import { ProductError, type Price } from "../../types";

export function normalizePrice(input: unknown, currency = "USD"): Price {
  const raw = typeof input === "number" ? String(input) : typeof input === "string" ? input.trim() : "";
  const numeric = raw.replace(/^\$/, "").replace(/,/g, "");
  if (!/^\d+(?:\.\d{1,2})?$/.test(numeric)) throw new ProductError("INVALID_PRICE", "extraction", `Malformed price: ${raw.slice(0, 30)}`);
  const value = Number(numeric);
  if (!Number.isFinite(value) || value <= 0) throw new ProductError("INVALID_PRICE", "extraction", "Price must be positive");
  if (currency !== "USD") throw new ProductError("UNSUPPORTED_CURRENCY", "extraction", `Unsupported currency ${currency}`);
  return { value, formatted: new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value), currency };
}
