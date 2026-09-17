import { SovrnApiError, SovrnClient } from "../src/stores/sovrn/client";
import {
  parseSovrnPilotCandidates,
  runSovrnPilotLookups,
  summarizeSovrnPilotLookup
} from "../src/stores/sovrn/feasibility";
import { sovrnMerchantAdapters } from "../src/stores/sovrn/merchant-registry";
import { inspectApprovedMerchants } from "../src/stores/sovrn/response-shape";
import { fetchSovrnSourceIdentities } from "../src/stores/sovrn/source-identity-feasibility";
import type { SovrnApprovedMerchantFinding } from "../src/stores/sovrn/types";

const requiredKeys = [
  "SOVRN_SECRET_KEY",
  "SOVRN_SITE_API_KEY",
  "SOVRN_CAMPAIGN_ID",
  "SOVRN_MARKET",
  "SOVRN_PILOT_PLAINLINKS_JSON"
] as const;

async function main(): Promise<void> {
  const missingKeys = requiredKeys.filter(key => !process.env[key]);
  if (missingKeys.length) {
    console.error(JSON.stringify({ event: "sovrn_direct_pilot_failed", success: false, errorCode: "SOVRN_CONFIG_MISSING", missingKeys }));
    process.exitCode = 2;
    return;
  }
  if (process.env.SOVRN_MARKET !== "usd_en") {
    console.error(JSON.stringify({ event: "sovrn_direct_pilot_failed", success: false, errorCode: "SOVRN_MARKET_INVALID", invalidKey: "SOVRN_MARKET" }));
    process.exitCode = 2;
    return;
  }

  let candidates;
  try {
    candidates = parseSovrnPilotCandidates(process.env.SOVRN_PILOT_PLAINLINKS_JSON!);
  } catch {
    console.error(JSON.stringify({ event: "sovrn_direct_pilot_failed", success: false, errorCode: "SOVRN_PILOT_INPUT_INVALID", invalidKey: "SOVRN_PILOT_PLAINLINKS_JSON" }));
    process.exitCode = 2;
    return;
  }

  const client = new SovrnClient({
    secretKey: process.env.SOVRN_SECRET_KEY!,
    siteApiKey: process.env.SOVRN_SITE_API_KEY!,
    campaignId: process.env.SOVRN_CAMPAIGN_ID!,
    market: "usd_en"
  });
  const domains = candidates.flatMap(candidate => [...sovrnMerchantAdapters[candidate.store].domains]);
  let merchantFindings: SovrnApprovedMerchantFinding[] = domains.map(domain => ({
    domain, found: false, approved: false, statusFields: [], identityFields: []
  }));
  let merchants: unknown;
  try {
    const response = await client.approvedMerchantsDetailed(domains, "sovrn-direct-feasibility");
    merchantFindings = inspectApprovedMerchants(response.value, domains);
    merchants = { httpStatus: response.httpStatus, findings: merchantFindings };
  } catch (error) {
    merchants = {
      httpStatus: error instanceof SovrnApiError ? error.httpStatus : undefined,
      errorCode: error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "SOVRN_PILOT_FAILED"
    };
  }

  const lookups = await runSovrnPilotLookups({
    candidates,
    merchantFindings,
    compare: input => client.compareByPlainlinkDetailed(input)
  });
  const sourceIdentities = await fetchSovrnSourceIdentities(candidates);
  console.log(JSON.stringify({
    event: "sovrn_direct_pilot_result",
    success: true,
    market: "usd_en",
    merchants,
    results: lookups.map(summarizeSovrnPilotLookup),
    sourceIdentities
  }));
}

main().catch(error => {
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "SOVRN_PILOT_FAILED";
  console.error(JSON.stringify({ event: "sovrn_direct_pilot_failed", success: false, errorCode }));
  process.exitCode = 2;
});
