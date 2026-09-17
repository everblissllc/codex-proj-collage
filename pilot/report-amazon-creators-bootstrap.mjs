import { readFileSync } from "node:fs";

const inputPath = process.argv[2];
const httpStatus = Number(process.argv[3]);
const allowedKeys = new Set([
  "AMAZON_CREATORS_CLIENT_ID",
  "AMAZON_CREATORS_CLIENT_SECRET",
  "AMAZON_CREATORS_CREDENTIAL_VERSION",
  "AMAZON_CREATORS_MARKETPLACE",
  "AMAZON_CREATORS_PARTNER_TAG",
  "PILOT_RUN_SECRET"
]);

let parsed;
try {
  parsed = JSON.parse(readFileSync(inputPath, "utf8"));
} catch {
  console.error(JSON.stringify({ event: "amazon_creators_pilot_http_error", httpStatus, success: false, errorCode: "PILOT_RESPONSE_INVALID" }));
  process.exit(3);
}

const errorCode = typeof parsed?.errorCode === "string" && /^[A-Z][A-Z0-9_]*$/.test(parsed.errorCode)
  ? parsed.errorCode
  : "PILOT_RESPONSE_INVALID";
const missingKeys = Array.isArray(parsed?.missingKeys)
  ? parsed.missingKeys.filter(key => typeof key === "string" && allowedKeys.has(key))
  : undefined;
const invalidKey = typeof parsed?.invalidKey === "string" && allowedKeys.has(parsed.invalidKey)
  ? parsed.invalidKey
  : undefined;

console.error(JSON.stringify({
  event: "amazon_creators_pilot_http_error",
  httpStatus,
  success: parsed?.success === true,
  errorCode,
  missingKeys,
  invalidKey
}));

if (["PILOT_BOOTSTRAP_NOT_READY", "PILOT_CONFIG_MISSING"].includes(errorCode)) process.exit(75);
process.exit(2);
