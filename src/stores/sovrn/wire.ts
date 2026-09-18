import { ProductError } from "../../types";
import type { SovrnWireOffer } from "./types";

const record = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const text = (value: unknown): string | undefined => typeof value === "string" && value.trim() ? value.trim() : undefined;
const finite = (value: unknown): number | undefined => typeof value === "number" && Number.isFinite(value) ? value : undefined;
const id = (value: unknown): string | number | undefined => typeof value === "string" || typeof value === "number" ? value : undefined;

function stockState(item: Record<string, unknown>): SovrnWireOffer["stockState"] {
  const value = text(item.stock ?? item.availability ?? item.stockStatus)?.toLowerCase();
  if (!value) return "unknown";
  if (/out[ _-]?of[ _-]?stock|unavailable/.test(value)) return "out_of_stock";
  if (/in[ _-]?stock|available/.test(value)) return "in_stock";
  return "unknown";
}

export function decodeSovrnOffers(value: unknown): SovrnWireOffer[] {
  if (!Array.isArray(value)) throw new ProductError("SOVRN_PROVIDER_ERROR", "extraction", "Sovrn response shape was invalid");
  return value.slice(0, 100).flatMap(candidate => {
    const item = record(candidate);
    const merchant = record(item?.merchant);
    const merchantName = text(merchant?.name);
    if (!item || !merchantName) return [];
    return [{
      merchantName,
      merchantId: id(merchant?.id),
      title: text(item.name),
      offerId: id(item.id),
      salePrice: finite(item.salePrice),
      retailPrice: finite(item.retailPrice),
      currency: text(item.currency),
      discountRate: finite(item.discountRate),
      affiliatable: typeof item.affiliatable === "boolean" ? item.affiliatable : undefined,
      imageUrl: text(item.image),
      thumbnailUrl: text(item.thumbnail),
      stockState: stockState(item),
      identity: {
        barcode: text(item.barcode), gtin: text(item.gtin), upc: text(item.upc), ean: text(item.ean),
        sku: text(item.sku), mpn: text(item.mpn), productId: text(item.productId ?? item.product_id)
      }
    }];
  });
}
