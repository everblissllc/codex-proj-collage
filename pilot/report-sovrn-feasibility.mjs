import { readFileSync } from "node:fs";

let payload;
try { payload = JSON.parse(readFileSync(process.argv[2], "utf8")); }
catch { console.error(JSON.stringify({ event: "sovrn_pilot_failed", success: false, errorCode: "PILOT_RESPONSE_INVALID" })); process.exit(2); }
const safe = payload?.success === true ? {
  event: "sovrn_pilot_result", success: true, source: payload.source, market: payload.market,
  merchants: payload.merchants, results: payload.results
} : {
  event: "sovrn_pilot_failed", success: false,
  errorCode: typeof payload?.errorCode === "string" ? payload.errorCode : "PILOT_RESPONSE_INVALID",
  missingKeys: Array.isArray(payload?.missingKeys) ? payload.missingKeys.filter(value => typeof value === "string") : undefined,
  invalidKey: typeof payload?.invalidKey === "string" ? payload.invalidKey : undefined
};
console.log(JSON.stringify(safe));
if (!safe.success) process.exit(2);
