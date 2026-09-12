import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../wrangler.smoke.jsonc", import.meta.url), "utf8"));
const queueName = config.queues.producers[0].queue;
if (queueName !== "affiliate-deal-card-smoke-jobs") throw new Error("Refusing to manage an unexpected queue");
const account = process.env.CLOUDFLARE_ACCOUNT_ID;
const token = process.env.CLOUDFLARE_API_TOKEN;
if (!account || !token) throw new Error("Cloudflare CI credentials are required");
const base = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(account)}/queues`;
const headers = { Authorization: `Bearer ${token}` };

for (let page = 1; page <= 100; page++) {
  const response = await fetch(`${base}?page=${page}&per_page=100`, { headers });
  if (!response.ok) throw new Error(`Queue list failed with HTTP ${response.status}`);
  const body = await response.json();
  if (!body.success || !Array.isArray(body.result)) throw new Error("Queue list returned an invalid response");
  if (body.result.some((item) => item.queue_name === queueName)) {
    console.log(`Smoke queue already exists: ${queueName}`);
    process.exit(0);
  }
  const totalPages = body.result_info?.total_pages;
  if (typeof totalPages === "number" && totalPages > 100) throw new Error("Too many Queue pages to safely verify the smoke Queue");
  if (typeof totalPages === "number" && page < totalPages) continue;
  if (body.result.length === 100 && typeof totalPages !== "number") throw new Error("Queue list pagination could not be verified");
  break;
}

const response = await fetch(base, {
  method: "POST",
  headers: { ...headers, "content-type": "application/json" },
  body: JSON.stringify({ queue_name: queueName })
});
const body = await response.json();
if (!response.ok || !body.success || body.result?.queue_name !== queueName) throw new Error(`Smoke queue creation failed with HTTP ${response.status}`);
console.log(`Created smoke queue: ${queueName}`);
