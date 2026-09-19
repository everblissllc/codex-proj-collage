import type { SovrnIdentityAssessment, SovrnSourceEvidence, SovrnVariantEvidence, SovrnWireOffer } from "../sovrn/types";

const normalized = (value: string): string => value.toLowerCase().replace(/[‐‑‒–—-]/g, " ")
  .replace(/[^a-z0-9.]+/g, " ").replace(/\s+/g, " ").trim();
const containsPhrase = (value: string, expected: string | undefined): boolean => {
  if (!expected) return false;
  const haystack = ` ${normalized(value)} `;
  const needle = ` ${normalized(expected)} `;
  return needle.length > 2 && haystack.includes(needle);
};
const numberEqual = (left: number, right: number): boolean => Math.abs(left - right) < 0.000_001;

type Dimensions = { width: number; height: number; depth: number };
function dimensionsFromTitle(title: string): Partial<Dimensions> {
  const read = (labels: string): number | undefined => {
    const before = title.match(new RegExp(`(\\d+(?:\\.\\d+)?)\\s*(?:in\\.?|inch(?:es)?)?\\s*(?:${labels})\\b`, "i"));
    const after = title.match(new RegExp(`(?:${labels})\\s*[:=-]?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:in\\.?|inch(?:es)?)`, "i"));
    return Number(before?.[1] ?? after?.[1]) || undefined;
  };
  return { width: read("w|width|wide"), height: read("h|height|high"), depth: read("d|depth|deep") };
}
const knownColors = ["black", "white", "red", "blue", "green", "silver", "gray", "grey", "pink", "purple", "gold", "brown", "beige"];
const knownMaterials = ["steel", "aluminum", "plastic", "wood", "resin", "metal"];
const knownMountings = ["wall mounted", "floor mounted", "freestanding", "base mounted", "ceiling mounted"];
const titleValue = (title: string, values: readonly string[]): string | undefined => values.find(value => containsPhrase(title, value));
const gauge = (value: string): number | undefined => {
  const match = value.match(/(\d+(?:\.\d+)?)\s*[- ]?gauge/i);
  return match ? Number(match[1]) : undefined;
};
const packCount = (value: string): number | undefined => {
  const match = value.match(/\b(\d+)\s*[- ]?(?:pack|count|ct)\b/i);
  return match ? Number(match[1]) : undefined;
};

function sourceMaterial(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return titleValue(value, knownMaterials);
}

export function assessHomeDepotSovrnIdentity(source: SovrnSourceEvidence, offer: SovrnWireOffer): SovrnIdentityAssessment {
  const evidence = source.homeDepot;
  const title = offer.title ?? "";
  const sourceVariant: SovrnVariantEvidence = source.variant;
  const offerModel = offer.identity.mpn ?? (evidence?.model && containsPhrase(title, evidence.model) ? evidence.model : undefined);
  const offerDimensions = dimensionsFromTitle(title);
  const offerColor = titleValue(title, knownColors);
  const offerGauge = gauge(title);
  const offerMaterial = titleValue(title, knownMaterials);
  const offerMounting = titleValue(title, knownMountings);
  const offerPack = packCount(title);
  const offerVariant: SovrnVariantEvidence = {
    explicit: Boolean(offerModel || offerColor || offerPack),
    mpn: offerModel,
    color: offerColor,
    pack: offerPack === undefined ? undefined : String(offerPack),
    sku: offer.identity.sku,
    upc: offer.identity.upc,
    gtin: offer.identity.gtin
  };

  if (!source.productIdConfirmed || !evidence || !title) {
    return { productMatchConfirmed: false, variantClassification: "VARIANT_AMBIGUOUS_HIGH_RISK", sourceVariant, offerVariant };
  }

  const sourceDimensions = evidence.dimensions;
  const sourceGauge = evidence.construction?.gauge;
  const material = sourceMaterial(evidence.construction?.material);
  const sourceMounting = evidence.mounting && titleValue(evidence.mounting, knownMountings);
  const brandMatch = containsPhrase(title, evidence.brand);
  const familyMatch = containsPhrase(title, evidence.productFamily);
  const colorMatch = Boolean(evidence.color && containsPhrase(title, evidence.color));
  const dimensionValues = [offerDimensions.width, offerDimensions.height, offerDimensions.depth];
  const dimensionsMatch = Boolean(sourceDimensions && dimensionValues.every(value => value !== undefined) &&
    numberEqual(offerDimensions.width!, sourceDimensions.width) &&
    numberEqual(offerDimensions.height!, sourceDimensions.height) &&
    numberEqual(offerDimensions.depth!, sourceDimensions.depth));
  const constructionMatch = Boolean(sourceGauge !== undefined && material && offerGauge !== undefined && offerMaterial &&
    numberEqual(sourceGauge, offerGauge) && material === offerMaterial);
  const mountingMatch = Boolean(sourceMounting && offerMounting === sourceMounting && containsPhrase(title, evidence.productFamily));
  const packMatch = evidence.packCount === undefined ? offerPack === undefined || offerPack === 1 : offerPack === evidence.packCount;

  const modelConflict = Boolean(offer.identity.mpn && evidence.model && normalized(offer.identity.mpn) !== normalized(evidence.model));
  const dimensionConflict = Boolean(sourceDimensions && dimensionValues.some(value => value !== undefined) && !dimensionsMatch);
  const colorConflict = Boolean(offerColor && evidence.color && normalized(offerColor) !== normalized(evidence.color));
  const constructionConflict = Boolean((offerGauge !== undefined && sourceGauge !== undefined && !numberEqual(offerGauge, sourceGauge)) ||
    (offerMaterial && material && offerMaterial !== material));
  const mountingConflict = Boolean(offerMounting && sourceMounting && offerMounting !== sourceMounting);
  const packConflict = !packMatch;
  if (modelConflict || dimensionConflict || colorConflict || constructionConflict || mountingConflict || packConflict) {
    return { productMatchConfirmed: false, variantClassification: "VARIANT_CONFLICT", sourceVariant, offerVariant };
  }

  const allStrongGroupsMatch = brandMatch && familyMatch && dimensionsMatch && colorMatch && constructionMatch && mountingMatch && packMatch;
  if (!allStrongGroupsMatch) {
    return { productMatchConfirmed: false, variantClassification: "VARIANT_AMBIGUOUS_HIGH_RISK", sourceVariant, offerVariant };
  }

  return {
    productMatchConfirmed: true,
    variantClassification: offerModel ? "EXACT_VARIANT_MATCH" : "NO_VARIANT_CONFLICT",
    sourceVariant,
    offerVariant
  };
}
