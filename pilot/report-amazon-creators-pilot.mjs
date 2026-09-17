import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

const inputPath = process.argv[2];
const artifactDirectory = process.argv[3];
const data = JSON.parse(readFileSync(inputPath, "utf8"));
mkdirSync(artifactDirectory, { recursive: true });

for (const card of Array.isArray(data.cards) ? data.cards : []) {
  if (!card || typeof card.filename !== "string" || !/^amazon-card-pilot-[A-Z0-9]{10}\.png$/.test(card.filename) || typeof card.pngBase64 !== "string") continue;
  writeFileSync(`${artifactDirectory}/${card.filename}`, Buffer.from(card.pngBase64, "base64"));
}

const safe = {
  success: data.success,
  source: data.source,
  amazonHtmlExtractionUsed: data.amazonHtmlExtractionUsed,
  amazonBrowserNavigationUsed: data.amazonBrowserNavigationUsed,
  amazonCardCacheUsed: data.amazonCardCacheUsed,
  token: data.token,
  rate: data.rate,
  results: data.results
};
console.log(JSON.stringify({ event: "amazon_creators_pilot_result", ...safe }));
if (!data.success) process.exitCode = 2;
