import { SovrnApiError, SovrnClient } from "../src/stores/sovrn/client";
import { describeSovrnResponse, inspectApprovedMerchants } from "../src/stores/sovrn/response-shape";
import { buildSovrnPlainlink } from "../src/stores/sovrn/plainlink";
import { sovrnMerchantAdapters } from "../src/stores/sovrn/merchant-registry";
import type { SovrnStoreId } from "../src/stores/sovrn/types";

type Env = {
  SOVRN_SECRET_KEY?: string;
  SOVRN_SITE_API_KEY?: string;
  SOVRN_CAMPAIGN_ID?: string;
  SOVRN_MARKET?: string;
  SOVRN_PILOT_PLAINLINKS_JSON?: string;
  PILOT_RUN_SECRET?: string;
};

function secureEqual(actual: string | null, expected?: string): boolean {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let different = 0;
  for (let index = 0; index < actual.length; index++) different |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return different === 0;
}

function configured(env: Env): string[] {
  return ["SOVRN_SECRET_KEY", "SOVRN_SITE_API_KEY", "SOVRN_CAMPAIGN_ID", "SOVRN_MARKET", "SOVRN_PILOT_PLAINLINKS_JSON", "PILOT_RUN_SECRET"]
    .filter(key => !env[key as keyof Env]);
}

function parseCandidates(value: string): Array<{ store: SovrnStoreId; url: string }> {
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("invalid candidates");
  return Object.entries(parsed as Record<string, unknown>).map(([store, url]) => {
    if (!(store in sovrnMerchantAdapters) || typeof url !== "string") throw new Error("invalid candidate");
    return { store: store as SovrnStoreId, url };
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true });
    if (request.method !== "POST" || url.pathname !== "/pilot") return new Response("Not found", { status: 404 });
    if (!secureEqual(request.headers.get("x-pilot-secret"), env.PILOT_RUN_SECRET)) return Response.json({ success: false, errorCode: "PILOT_UNAUTHORIZED" }, { status: 401 });
    const missingKeys = configured(env);
    if (missingKeys.length) return Response.json({ success: false, errorCode: "PILOT_CONFIG_MISSING", missingKeys }, { status: 503 });
    if (env.SOVRN_MARKET !== "usd_en") return Response.json({ success: false, errorCode: "PILOT_MARKET_INVALID", invalidKey: "SOVRN_MARKET" }, { status: 400 });
    let candidates: Array<{ store: SovrnStoreId; url: string }>;
    try { candidates = parseCandidates(env.SOVRN_PILOT_PLAINLINKS_JSON!); }
    catch { return Response.json({ success: false, errorCode: "PILOT_CANDIDATES_INVALID", invalidKey: "SOVRN_PILOT_PLAINLINKS_JSON" }, { status: 400 }); }
    const client = new SovrnClient({
      secretKey: env.SOVRN_SECRET_KEY!, siteApiKey: env.SOVRN_SITE_API_KEY!, market: "usd_en", campaignId: env.SOVRN_CAMPAIGN_ID!
    });
    try {
      const domains = candidates.flatMap(candidate => [...sovrnMerchantAdapters[candidate.store].domains]);
      const merchantResponse = await client.approvedMerchantsDetailed(domains, "sovrn-feasibility");
      const merchantFindings = inspectApprovedMerchants(merchantResponse.value, domains);
      const merchants = { httpStatus: merchantResponse.httpStatus, structure: describeSovrnResponse(merchantResponse.value), findings: merchantFindings };
      const results = [];
      for (const candidate of candidates) {
        try {
          const lookup = buildSovrnPlainlink(candidate.url, candidate.store);
          const domain = sovrnMerchantAdapters[candidate.store].domains[0];
          const approved = merchantFindings.find(finding => finding.domain === domain)?.approved === true;
          if (!approved) {
            results.push({ store: candidate.store, hostname: new URL(lookup.plainlink).hostname, approved: false, lookupSkipped: true, errorCode: "SOVRN_MERCHANT_NOT_APPROVED" });
            continue;
          }
          const response = await client.compareByPlainlinkDetailed({ plainlink: lookup.plainlink, store: candidate.store, requestId: "sovrn-feasibility" });
          results.push({
            store: candidate.store, hostname: new URL(lookup.plainlink).hostname, approved: true, httpStatus: response.httpStatus,
            pathShape: new URL(lookup.plainlink).pathname.replace(/[A-Za-z0-9]{6,}/g, ":id"),
            productIdentityPresent: Boolean(lookup.productIdentity), structure: describeSovrnResponse(response.value)
          });
        } catch (error) {
          results.push({
            store: candidate.store,
            httpStatus: error instanceof SovrnApiError ? error.httpStatus : undefined,
            errorCode: error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "SOVRN_PILOT_FAILED"
          });
        }
      }
      return Response.json({ success: true, source: "sovrn-price-comparison", market: "usd_en", merchants, results });
    } catch (error) {
      const productError = error && typeof error === "object" && "code" in error ? error as { code?: unknown } : undefined;
      return Response.json({ success: false, errorCode: typeof productError?.code === "string" ? productError.code : "SOVRN_PILOT_FAILED" }, { status: 502 });
    }
  }
} satisfies ExportedHandler<Env>;
