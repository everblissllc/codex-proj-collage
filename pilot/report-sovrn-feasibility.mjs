import { readFileSync } from "node:fs";

const httpStatus = Number(process.argv[3]);
const expectedBuildId = process.argv[5] ?? "";
const allowedKeys = new Set([
  "SOVRN_SECRET_KEY", "SOVRN_SITE_API_KEY", "SOVRN_CAMPAIGN_ID", "SOVRN_MARKET",
  "SOVRN_PILOT_PLAINLINKS_JSON", "SOVRN_PILOT_BUILD_ID", "PILOT_RUN_SECRET"
]);
let payload;
try { payload = JSON.parse(readFileSync(process.argv[2], "utf8")); }
catch { payload = undefined; }
let headerText = "";
try { headerText = readFileSync(process.argv[4], "utf8"); }
catch { /* Missing headers are reported as absent. */ }
const headerValue = name => {
  const matches = [...headerText.matchAll(new RegExp(`^${name}:\\s*([^\\r\\n]+)$`, "gim"))];
  return matches.at(-1)?.[1]?.trim();
};
const observedMarker = headerValue("x-sovrn-pilot-build");
const rawContentType = headerValue("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
const contentType = rawContentType && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(rawContentType) ? rawContentType : undefined;
const rawCfRay = headerValue("cf-ray");
const cloudflareRequestId = rawCfRay && /^[a-z0-9-]{1,100}$/i.test(rawCfRay) ? rawCfRay : undefined;
const responseMetadata = {
  markerPresent: Boolean(observedMarker),
  markerMatchesExpectedBuild: Boolean(observedMarker && expectedBuildId && observedMarker === expectedBuildId),
  contentType,
  cloudflareRequestId
};
const safe = payload?.success === true ? {
  event: "sovrn_pilot_result", success: true, httpStatus, source: payload.source, market: payload.market,
  ...responseMetadata, merchants: payload.merchants, results: payload.results
} : {
  event: "sovrn_pilot_failed", success: false, httpStatus, ...responseMetadata,
  errorCode: typeof payload?.errorCode === "string" ? payload.errorCode : "PILOT_RESPONSE_INVALID",
  missingKeys: Array.isArray(payload?.missingKeys) ? payload.missingKeys.filter(value => typeof value === "string" && allowedKeys.has(value)) : undefined,
  invalidKey: typeof payload?.invalidKey === "string" && allowedKeys.has(payload.invalidKey) ? payload.invalidKey : undefined
};
console.log(JSON.stringify(safe));
if (!safe.success) process.exit(2);
