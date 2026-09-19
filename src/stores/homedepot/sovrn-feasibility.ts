import type { ProductData } from "../../types";
import type { SovrnIdentityAssessment } from "../sovrn/types";

export type HomeDepotSovrnParity = {
  eligible: boolean;
  currentParity: "EXACT" | "DIFFERENT" | "UNAVAILABLE";
  referenceParity: "EXACT" | "DIFFERENT" | "HOME_DEPOT_ONLY" | "SOVRN_ONLY" | "NEITHER";
  homeDepotCurrentCents?: number;
  sovrnCurrentCents?: number;
  deltaCents?: number;
};

const cents = (value: number | undefined): number | undefined => {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const result = Math.round(value * 100);
  return Math.abs(value * 100 - result) < 0.000_001 ? result : undefined;
};

export function assessHomeDepotSovrnParity(
  source: ProductData,
  candidate: ProductData,
  identity: SovrnIdentityAssessment
): HomeDepotSovrnParity {
  const homeDepotCurrentCents = cents(source.currentPrice.value);
  const sovrnCurrentCents = cents(candidate.currentPrice.value);
  const currentParity = homeDepotCurrentCents === undefined || sovrnCurrentCents === undefined || source.currentPrice.currency !== candidate.currentPrice.currency
    ? "UNAVAILABLE"
    : homeDepotCurrentCents === sovrnCurrentCents ? "EXACT" : "DIFFERENT";
  const sourceReference = cents(source.oldPrice?.value);
  const sovrnReference = cents(candidate.oldPrice?.value);
  const referenceParity = sourceReference === undefined && sovrnReference === undefined ? "NEITHER"
    : sourceReference === undefined ? "SOVRN_ONLY"
      : sovrnReference === undefined ? "HOME_DEPOT_ONLY"
        : sourceReference === sovrnReference ? "EXACT" : "DIFFERENT";
  return {
    eligible: identity.productMatchConfirmed &&
      ["EXACT_VARIANT_MATCH", "NO_VARIANT_CONFLICT"].includes(identity.variantClassification) &&
      currentParity === "EXACT",
    currentParity,
    referenceParity,
    homeDepotCurrentCents,
    sovrnCurrentCents,
    deltaCents: homeDepotCurrentCents === undefined || sovrnCurrentCents === undefined
      ? undefined
      : sovrnCurrentCents - homeDepotCurrentCents
  };
}
