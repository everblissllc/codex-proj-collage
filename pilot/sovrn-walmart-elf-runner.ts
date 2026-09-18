import { SovrnClient } from "../src/stores/sovrn/client";
import { runSovrnPilotLookups, summarizeSovrnPilotLookup, type SovrnPilotCandidate } from "../src/stores/sovrn/feasibility";
import { assessSovrnPilotIdentity, fetchSovrnSourceIdentities } from "../src/stores/sovrn/source-identity-feasibility";

const ELF_CANDIDATE = "https://www.elfcosmetics.com/products/hydrating-camo-concealer/";
const requiredKeys = ["SOVRN_SECRET_KEY", "SOVRN_SITE_API_KEY", "SOVRN_MARKET"] as const;

async function main(): Promise<void> {
  const missingKeys = requiredKeys.filter(key => !process.env[key]);
  if (missingKeys.length) {
    console.error(JSON.stringify({ event: "sovrn_walmart_elf_failed", errorCode: "SOVRN_CONFIG_MISSING", missingKeys }));
    process.exitCode = 2;
    return;
  }
  if (process.env.SOVRN_MARKET !== "usd_en") {
    console.error(JSON.stringify({ event: "sovrn_walmart_elf_failed", errorCode: "SOVRN_MARKET_INVALID", invalidKey: "SOVRN_MARKET" }));
    process.exitCode = 2;
    return;
  }

  const candidate: SovrnPilotCandidate = { store: "elf", url: ELF_CANDIDATE };
  const client = new SovrnClient({
    secretKey: process.env.SOVRN_SECRET_KEY!,
    siteApiKey: process.env.SOVRN_SITE_API_KEY!,
    market: "usd_en"
  });
  const [lookup] = await runSovrnPilotLookups({
    candidates: [candidate],
    merchantFindings: [],
    compare: input => client.compareByPlainlinkDetailed(input)
  });
  const [source] = await fetchSovrnSourceIdentities([candidate]);
  const identityAssessment = assessSovrnPilotIdentity(lookup, source);
  const result = summarizeSovrnPilotLookup(lookup, identityAssessment);
  console.log(JSON.stringify({
    event: "sovrn_walmart_elf_result",
    market: "usd_en",
    walmart: { tested: false, errorCode: "WALMART_CANDIDATE_REQUIRED" },
    elf: {
      tested: true,
      sourceUrlClass: "OFFICIAL_ELF_PRODUCT",
      ...result,
      identityAssessment,
      sourceIdentity: source,
      postUrlPreserved: source?.existingProduct?.postUrlPreserved === true
    }
  }));
}

main().catch(error => {
  const errorCode = error && typeof error === "object" && "code" in error && typeof error.code === "string"
    ? error.code
    : "SOVRN_PILOT_FAILED";
  console.error(JSON.stringify({ event: "sovrn_walmart_elf_failed", errorCode }));
  process.exitCode = 2;
});
