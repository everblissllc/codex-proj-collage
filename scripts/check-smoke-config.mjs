import { readFileSync } from "node:fs";

const production = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const smoke = JSON.parse(readFileSync(new URL("../wrangler.smoke.jsonc", import.meta.url), "utf8"));
const worker = "affiliate-deal-card-smoke";
const queue = "affiliate-deal-card-smoke-jobs";
function assert(condition, message) { if (!condition) throw new Error(`Smoke configuration: ${message}`); }

assert(smoke.name === worker && smoke.name !== production.name, "Worker name is not isolated");
assert(smoke.main === production.main, "Worker entry point differs from production");
assert(smoke.workers_dev === true && !smoke.routes && !smoke.route && !smoke.custom_domain, "Smoke Worker must use only workers.dev");
assert(smoke.ai?.binding === "AI" && smoke.browser?.binding === "BROWSER", "AI or Browser binding is missing");
assert(smoke.vars?.AI_TEXT_MODEL === "@cf/meta/llama-3.2-3b-instruct", "Unexpected AI model");
assert(smoke.queues?.producers?.length === 1 && smoke.queues.producers[0].binding === "PRODUCT_JOBS", "Unexpected producer bindings");
assert(smoke.queues.producers[0].queue === queue && smoke.queues.producers[0].queue !== production.queues.producers[0].queue, "Producer queue is not isolated");
assert(smoke.queues?.consumers?.length === 1 && smoke.queues.consumers[0].queue === queue, "Consumer queue is not isolated");
assert(!smoke.vars?.TELEGRAM_BOT_TOKEN && !smoke.vars?.TELEGRAM_WEBHOOK_SECRET, "Telegram credentials must be Worker secrets");
console.log(`Smoke configuration isolated: ${worker} / ${queue}`);
