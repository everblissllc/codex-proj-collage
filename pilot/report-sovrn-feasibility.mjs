import { readFileSync } from "node:fs";

const httpStatus = Number(process.argv[3]);
const allowedKeys = new Set([
  "SOVRN_SECRET_KEY", "SOVRN_SITE_API_KEY", "SOVRN_CAMPAIGN_ID", "SOVRN_MARKET",
  "SOVRN_PILOT_PLAINLINKS_JSON", "SOVRN_PILOT_BUILD_ID", "PILOT_RUN_SECRET"
]);
let payload;
try { payload = JSON.parse(readFileSync(process.argv[2], "utf8")); }
catch { console.error(JSON.stringify({ event: "sovrn_pilot_failed", success: false, httpStatus, errorCode: "PILOT_RESPONSE_INVALID" })); process.exit(2); }
const safe = payload?.success === true ? {
  event: "sovrn_pilot_result", success: true, httpStatus, source: payload.source, market: payload.market,
  merchants: payload.merchants, results: payload.results
} : {
  event: "sovrn_pilot_failed", success: false, httpStatus,
  errorCode: typeof payload?.errorCode === "string" ? payload.errorCode : "PILOT_RESPONSE_INVALID",
  missingKeys: Array.isArray(payload?.missingKeys) ? payload.missingKeys.filter(value => typeof value === "string" && allowedKeys.has(value)) : undefined,
  invalidKey: typeof payload?.invalidKey === "string" && allowedKeys.has(payload.invalidKey) ? payload.invalidKey : undefined
};
console.log(JSON.stringify(safe));
if (!safe.success) process.exit(2);
