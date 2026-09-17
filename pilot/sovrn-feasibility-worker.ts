import { SovrnApiError, SovrnClient } from "../src/stores/sovrn/client";
import { runSovrnPilotLookups } from "../src/stores/sovrn/feasibility";
import { inspectApprovedMerchants } from "../src/stores/sovrn/response-shape";
import { sovrnMerchantAdapters } from "../src/stores/sovrn/merchant-registry";
import { withSovrnPilotBuildMarker } from "../src/stores/sovrn/pilot-response";
import type { SovrnStoreId } from "../src/stores/sovrn/types";

type Env = {
  SOVRN_SECRET_KEY?: string;
  SOVRN_SITE_API_KEY?: string;
  SOVRN_CAMPAIGN_ID?: string;
  SOVRN_MARKET?: string;
  SOVRN_PILOT_PLAINLINKS_JSON?: string;
  SOVRN_PILOT_BUILD_ID?: string;
  PILOT_RUN_SECRET?: string;
};

function secureEqual(actual: string | null, expected?: string): boolean {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let different = 0;
  for (let index = 0; index < actual.length; index++) different |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return different === 0;
}

function configured(env: Env): string[] {
  return ["SOVRN_SECRET_KEY", "SOVRN_SITE_API_KEY", "SOVRN_CAMPAIGN_ID", "SOVRN_MARKET", "SOVRN_PILOT_PLAINLINKS_JSON", "SOVRN_PILOT_BUILD_ID", "PILOT_RUN_SECRET"]
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

function validateBootstrap(request: Request, env: Env): {
  response?: Response;
  candidates?: Array<{ store: SovrnStoreId; url: string }>;
} {
  if (!env.PILOT_RUN_SECRET) {
    return { response: Response.json({ success: false, errorCode: "PILOT_BOOTSTRAP_NOT_READY", missingKeys: ["PILOT_RUN_SECRET"] }, { status: 503 }) };
  }
  if (!secureEqual(request.headers.get("x-pilot-secret"), env.PILOT_RUN_SECRET)) {
    return { response: Response.json({ success: false, errorCode: "PILOT_UNAUTHORIZED" }, { status: 401 }) };
  }
  const missingKeys = configured(env);
  if (missingKeys.length) {
    return { response: Response.json({ success: false, errorCode: "PILOT_CONFIG_MISSING", missingKeys }, { status: 503 }) };
  }
  if (env.SOVRN_MARKET !== "usd_en") {
    return { response: Response.json({ success: false, errorCode: "PILOT_MARKET_INVALID", invalidKey: "SOVRN_MARKET" }, { status: 400 }) };
  }
  try { return { candidates: parseCandidates(env.SOVRN_PILOT_PLAINLINKS_JSON!) }; }
  catch {
    return { response: Response.json({ success: false, errorCode: "PILOT_CANDIDATES_INVALID", invalidKey: "SOVRN_PILOT_PLAINLINKS_JSON" }, { status: 400 }) };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const respond = (response: Response): Response => withSovrnPilotBuildMarker(response, env.SOVRN_PILOT_BUILD_ID);
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") return respond(Response.json({ ok: true }));
    const isReady = request.method === "GET" && url.pathname === "/ready";
    const isPilot = request.method === "POST" && url.pathname === "/pilot";
    if (!isReady && !isPilot) return respond(new Response("Not found", { status: 404 }));
    const bootstrap = validateBootstrap(request, env);
    if (bootstrap.response) return respond(bootstrap.response);
    if (isReady) return respond(Response.json({ success: true, ready: true, buildId: env.SOVRN_PILOT_BUILD_ID }));
    const candidates = bootstrap.candidates!;
    const client = new SovrnClient({
      secretKey: env.SOVRN_SECRET_KEY!, siteApiKey: env.SOVRN_SITE_API_KEY!, market: "usd_en", campaignId: env.SOVRN_CAMPAIGN_ID!
    });
    try {
      const domains = candidates.flatMap(candidate => [...sovrnMerchantAdapters[candidate.store].domains]);
      let merchantFindings: ReturnType<typeof inspectApprovedMerchants> = domains.map(domain => ({
        domain, found: false, approved: false, statusFields: [], identityFields: []
      }));
      let merchants: unknown;
      try {
        const merchantResponse = await client.approvedMerchantsDetailed(domains, "sovrn-feasibility");
        merchantFindings = inspectApprovedMerchants(merchantResponse.value, domains);
        merchants = { httpStatus: merchantResponse.httpStatus, findings: merchantFindings };
      } catch (error) {
        merchants = {
          httpStatus: error instanceof SovrnApiError ? error.httpStatus : undefined,
          errorCode: error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "SOVRN_PILOT_FAILED"
        };
      }
      const results = await runSovrnPilotLookups({
        candidates, merchantFindings,
        compare: input => client.compareByPlainlinkDetailed(input)
      });
      return respond(Response.json({ success: true, source: "sovrn-price-comparison", market: "usd_en", merchants, results }));
    } catch (error) {
      const productError = error && typeof error === "object" && "code" in error ? error as { code?: unknown } : undefined;
      return respond(Response.json({ success: false, errorCode: typeof productError?.code === "string" ? productError.code : "SOVRN_PILOT_FAILED" }, { status: 502 }));
    }
  }
} satisfies ExportedHandler<Env>;
