import { readFileSync } from "node:fs";

const status = Number(process.argv[2]);
const attempt = Number(process.argv[3]);
const allowedKeys = new Set([
  "SOVRN_SECRET_KEY", "SOVRN_SITE_API_KEY", "SOVRN_CAMPAIGN_ID", "SOVRN_MARKET",
  "SOVRN_PILOT_PLAINLINKS_JSON", "PILOT_RUN_SECRET"
]);
let payload;
try { payload = JSON.parse(readFileSync(process.argv[4], "utf8")); }
catch { payload = undefined; }
const errorCode = typeof payload?.errorCode === "string" ? payload.errorCode : status === 200 ? "PILOT_RESPONSE_INVALID" : "PILOT_HTTP_ERROR";
const missingKeys = Array.isArray(payload?.missingKeys)
  ? payload.missingKeys.filter(value => typeof value === "string" && allowedKeys.has(value))
  : [];
const invalidKey = typeof payload?.invalidKey === "string" && allowedKeys.has(payload.invalidKey) ? payload.invalidKey : undefined;
const ready = status === 200 && payload?.success === true && payload?.ready === true;
const retryable = status === 503 && (
  errorCode === "PILOT_BOOTSTRAP_NOT_READY" ||
  (errorCode === "PILOT_CONFIG_MISSING" && missingKeys.length > 0)
);
console.log(JSON.stringify({
  event: "sovrn_pilot_bootstrap", attempt, httpStatus: status, ready,
  errorCode: ready ? undefined : errorCode,
  missingKeys: missingKeys.length ? missingKeys : undefined,
  invalidKey
}));
process.exit(ready ? 0 : retryable ? 10 : 2);
