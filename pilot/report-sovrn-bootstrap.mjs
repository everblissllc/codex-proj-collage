import { readFileSync } from "node:fs";

const status = Number(process.argv[2]);
const attempt = Number(process.argv[3]);
const expectedBuildId = process.argv[5] ?? "";
const previousConsecutiveSuccesses = Number(process.argv[6] ?? 0);
const allowedKeys = new Set([
  "SOVRN_SECRET_KEY", "SOVRN_SITE_API_KEY", "SOVRN_CAMPAIGN_ID", "SOVRN_MARKET",
  "SOVRN_PILOT_PLAINLINKS_JSON", "SOVRN_PILOT_BUILD_ID", "PILOT_RUN_SECRET"
]);
let payload;
try { payload = JSON.parse(readFileSync(process.argv[4], "utf8")); }
catch { payload = undefined; }
const routeNotReady = status === 404;
const baseErrorCode = routeNotReady
  ? "PILOT_ROUTE_NOT_READY"
  : typeof payload?.errorCode === "string" ? payload.errorCode : status === 200 ? "PILOT_RESPONSE_INVALID" : "PILOT_HTTP_ERROR";
const missingKeys = Array.isArray(payload?.missingKeys)
  ? payload.missingKeys.filter(value => typeof value === "string" && allowedKeys.has(value))
  : [];
const invalidKey = typeof payload?.invalidKey === "string" && allowedKeys.has(payload.invalidKey) ? payload.invalidKey : undefined;
const responseReady = status === 200 && payload?.success === true && payload?.ready === true;
const observedBuildId = typeof payload?.buildId === "string" ? payload.buildId : "";
const buildMatches = responseReady && expectedBuildId.length > 0 && observedBuildId === expectedBuildId;
const buildNotReady = responseReady && !buildMatches;
const errorCode = buildNotReady ? "PILOT_BUILD_NOT_READY" : baseErrorCode;
const consecutiveSuccesses = buildMatches ? previousConsecutiveSuccesses + 1 : 0;
const retryable = routeNotReady || buildNotReady || (status === 503 && (
  errorCode === "PILOT_BOOTSTRAP_NOT_READY" ||
  (errorCode === "PILOT_CONFIG_MISSING" && missingKeys.length > 0)
));
console.log(JSON.stringify({
  event: "sovrn_pilot_bootstrap", attempt, httpStatus: status, ready: buildMatches,
  errorCode: buildMatches ? undefined : errorCode,
  missingKeys: missingKeys.length ? missingKeys : undefined,
  invalidKey,
  consecutiveSuccesses,
  expectedBuildShort: expectedBuildId.slice(0, 8) || undefined,
  observedBuildShort: observedBuildId.slice(0, 8) || undefined
}));
process.exit(buildMatches ? 0 : retryable ? 10 : 2);
