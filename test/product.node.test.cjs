const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const src = path => require(join(process.env.COMPILED_ROOT, path));
const { detectStore } = src("stores/detect-store.js");
const { validatePublicUrl, assertPublicDns, findProductUrl } = src("stores/safe-url.js");
const { resolveUrl } = src("stores/resolve-url.js");
const { extractWalmartProduct } = src("stores/walmart/extractor.js");
const { normalizePrice } = src("stores/walmart/price.js");
const { parseCopyDraft, parseWorkersAIResponse, WorkersAICopyProvider } = src("ai/workers-ai-provider.js");
const { generateProductCopy } = src("ai/generate-product-copy.js");
const { walmartCardHtml } = src("stores/walmart/template.js");
const { processProductLink } = src("orchestration/process-product-link.js");
const { handleTelegramWebhook, processTelegramJob } = src("telegram/webhook.js");
const withWas = readFileSync("test/fixtures/walmart-with-was.html", "utf8");
const currentOnly = readFileSync("test/fixtures/walmart-current-only.html", "utf8");
const input = "https://affiliate.example.org/go?id=abc";
const walmart = "https://www.walmart.com/ip/123";

test("Walmart URL detection and unsupported domain", () => {
  assert.equal(detectStore(walmart), "walmart");
  assert.equal(detectStore("https://notwalmart.com/item"), undefined);
  assert.equal(detectStore("https://amzn.to/a"), "amazon");
});
test("Telegram URL entity preserves exact trailing punctuation in an affiliate URL", () => {
  const text = "Link: https://affiliate.example.org/go?x=hello)";
  assert.equal(findProductUrl(text, [{ type: "url", offset: 6, length: text.length - 6 }]), "https://affiliate.example.org/go?x=hello)");
});
test("short link resolves with manual redirects", async () => {
  const calls = [];
  const responses = [new Response(null, { status: 302, headers: { location: walmart } }), new Response(withWas, { headers: { "content-type": "text/html" } })];
  const page = await resolveUrl(input, async (url, init) => { calls.push([url, init]); return responses.shift(); }, undefined, async () => {});
  assert.equal(page.resolvedUrl, walmart);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1].redirect, "manual");
});
test("SSRF redirect target is rejected before fetch", async () => {
  assert.throws(() => validatePublicUrl("http://169.254.169.254/"));
  let calls = 0;
  await assert.rejects(resolveUrl(input, async () => { calls++; return new Response(null, { status: 302, headers: { location: "http://10.0.0.5/" } }); }, undefined, async () => {}), { code: "UNSAFE_URL" });
  assert.equal(calls, 1);
});
test("DNS preflight rejects a public hostname resolving to private IP", async () => {
  const original = global.fetch;
  try {
    global.fetch = async url => Response.json({ Status: 0, Answer: url.endsWith("type=A") ? [{ type: 1, data: "10.1.2.3" }] : [] });
    await assert.rejects(assertPublicDns("public-looking.example.org"), { code: "UNSAFE_URL" });
  } finally { global.fetch = original; }
});
test("extracts valid current and old prices", () => {
  const p = extractWalmartProduct(withWas, input, walmart);
  assert.equal(p.currentPrice.formatted, "$59.00");
  assert.equal(p.oldPrice.formatted, "$99.00");
  assert.equal(p.canonicalProductUrl, walmart);
  assert.equal(p.inputUrl, input);
  assert.equal(p.postUrl, input);
});
test("current price with no old price", () => {
  const p = extractWalmartProduct(currentOnly, input, walmart);
  assert.equal(p.currentPrice.value, 59);
  assert.equal(p.oldPrice, undefined);
});
test("malformed price fails", () => {
  assert.throws(() => normalizePrice("$59-$99"), { code: "INVALID_PRICE" });
  assert.throws(() => extractWalmartProduct(currentOnly.replace("59.00", "Call"), input, walmart), { code: "MISSING_PRICE" });
});
test("missing product image fails", () => {
  assert.throws(() => extractWalmartProduct(currentOnly.replace(/<meta property="og:image"[^>]+>/, ""), input, walmart), { code: "MISSING_IMAGE" });
});
test("embedded Walmart state fallback", () => {
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { product: { name: "Toniebox Elsa", imageUrl: "https://i5.walmartimages.com/seo/test.jpg", priceInfo: { currentPrice: { price: 59 }, wasPrice: { price: 99 } } } } } })}</script>`;
  const p = extractWalmartProduct(html, input, walmart);
  assert.equal(p.rawTitle, "Toniebox Elsa");
  assert.equal(p.oldPrice.value, 99);
});
test("failed AI JSON content is rejected", () => {
  assert.throws(() => parseCopyDraft({ shortTitle: "Now $59", facebookBody: "Buy" }), { code: "AI_INVALID_CONTENT" });
  assert.throws(() => parseCopyDraft({ shortTitle: "Toniebox", facebookBody: "https://wrong.link" }), { code: "AI_INVALID_CONTENT" });
});
test("malformed Workers AI JSON response fails explicitly", async () => {
  const p = extractWalmartProduct(withWas, input, walmart);
  const provider = new WorkersAICopyProvider({ run: async () => ({ response: "not json" }) }, "test-model");
  await assert.rejects(provider.generate(p), { code: "AI_BAD_JSON" });
});
test("Workers AI provider makes one URL-free text inference and accepts fenced JSON", async () => {
  const p = extractWalmartProduct(withWas, input, walmart);
  let calls = 0;
  const provider = new WorkersAICopyProvider({ run: async (model, options) => {
    calls++;
    assert.equal(model, "@cf/meta/llama-3.2-3b-instruct");
    assert.ok(!JSON.stringify(options).includes(input));
    assert.equal(options.messages.length, 2);
    return { response: '```json\n{"shortTitle":"Disney Toniebox Starter Set","facebookBody":"Disney Toniebox Starter Set is now $59.00, was $99.00."}\n```' };
  } }, "@cf/meta/llama-3.2-3b-instruct");
  const draft = await provider.generate(p);
  assert.equal(draft.shortTitle, "Disney Toniebox Starter Set");
  assert.equal(calls, 1);
  assert.throws(() => parseWorkersAIResponse({ response: { shortTitle: "Now $59", facebookBody: "Buy" } }), { code: "AI_INVALID_CONTENT" });
});
test("exact affiliate URL is appended outside AI", async () => {
  const p = extractWalmartProduct(withWas, input, walmart);
  const copy = await generateProductCopy(p, { generate: async () => ({ shortTitle: "Disney Toniebox Starter Set", facebookBody: "Disney Toniebox Starter Set is now $59.00, was $99.00." }) }, "#Ad");
  assert.ok(copy.facebookPost.endsWith(input));
  assert.ok(!copy.facebookPost.includes(walmart));
});
test("AI body cannot change or omit authoritative prices", async () => {
  const p = extractWalmartProduct(withWas, input, walmart);
  await assert.rejects(generateProductCopy(p, { generate: async () => ({ shortTitle: "Disney Toniebox Starter Set", facebookBody: "Disney Toniebox Starter Set is now $49.00, was $99.00." }) }), { code: "AI_INVALID_CONTENT" });
  await assert.rejects(generateProductCopy(p, { generate: async () => ({ shortTitle: "Disney Toniebox Starter Set", facebookBody: "Disney Toniebox Starter Set is now $59.00." }) }), { code: "AI_INVALID_CONTENT" });
});
test("long title stays bounded and image aspect ratio is preserved", () => {
  const p = extractWalmartProduct(withWas, input, walmart);
  const html = walmartCardHtml(p, { shortTitle: "Disney Toniebox Starter Set with Elsa and Many More Description Words That Are Deliberately Long", facebookPost: "" }, "data:image/png;base64,AAAA");
  assert.ok(html.includes("font-size:49px"));
  assert.ok(html.includes("-webkit-line-clamp:3"));
  assert.ok(html.includes("object-fit:contain"));
});
test("unsupported store stops before AI and rendering", async () => {
  let called = false;
  await assert.rejects(processProductLink("https://example.org/item", { fetcher: async () => new Response("html"), dnsCheck: async () => {}, copyProvider: { generate: async () => { called = true; throw new Error(); } }, renderer: { screenshot: async () => { called = true; throw new Error(); } }, disclosure: "#Ad", requestId: "test" }), { code: "UNSUPPORTED_STORE" });
  assert.equal(called, false);
});
test("orchestration uses one page fetch and one image fetch", async () => {
  const responses = [new Response(null, { status: 302, headers: { location: walmart } }), new Response(withWas, { headers: { "content-type": "text/html" } }), new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { "content-type": "image/png" } })];
  const fetchedUrls = []; let renders = 0;
  const result = await processProductLink(input, { fetcher: async url => { fetchedUrls.push(url); return responses.shift(); }, dnsCheck: async () => {}, copyProvider: { generate: async () => ({ shortTitle: "Disney Toniebox Starter Set", facebookBody: "Disney Toniebox Starter Set is now $59.00, was $99.00." }) }, renderer: { screenshot: async () => { renders++; return { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" }; } }, disclosure: "#Ad", requestId: "test" });
  assert.equal(result.product.resolvedUrl, walmart);
  assert.deepEqual(fetchedUrls.slice(0, 2), [input, walmart]);
  assert.match(fetchedUrls[2], /^https:\/\/i5\.walmartimages\.com\//);
  assert.equal(renders, 1);
});
test("authenticated /start sends the invalid-link reply with the native fetch receiver", async () => {
  const original = global.fetch;
  const sent = [];
  const waits = [];
  let queued = false;
  try {
    global.fetch = function (url, init) {
      assert.equal(this, globalThis);
      assert.match(String(url), /^https:\/\/api\.telegram\.org\/bottest-token\/sendMessage$/);
      sent.push(JSON.parse(init.body));
      return Promise.resolve(Response.json({ ok: true }));
    };
    const env = { TELEGRAM_BOT_TOKEN: "test-token", TELEGRAM_WEBHOOK_SECRET: "secret", PRODUCT_JOBS: { send: async () => { queued = true; } } };
    const request = new Request("https://bot.example/telegram/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": "secret" }, body: JSON.stringify({ message: { text: "/start", chat: { id: 123 }, from: { id: 456 } } }) });
    const response = await handleTelegramWebhook(request, env, { waitUntil: promise => { waits.push(promise); } });
    await Promise.all(waits);
    assert.equal(response.status, 200);
    assert.equal(queued, false);
    assert.deepEqual(sent, [{ chat_id: 123, text: "Please send a valid product link.", disable_web_page_preview: true }]);
  } finally { global.fetch = original; }
});
test("Telegram webhook authenticates and enqueues exact link", async () => {
  let queued;
  const env = { TELEGRAM_WEBHOOK_SECRET: "secret", PRODUCT_JOBS: { send: async value => { queued = value; } } };
  const makeRequest = secret => new Request("https://bot.example/telegram/webhook", { method: "POST", headers: { "X-Telegram-Bot-Api-Secret-Token": secret }, body: JSON.stringify({ message: { text: input, chat: { id: 123 }, from: { id: 456 } } }) });
  const ctx = { waitUntil: () => {} };
  assert.equal((await handleTelegramWebhook(makeRequest("wrong"), env, ctx)).status, 401);
  assert.equal(queued, undefined);
  assert.equal((await handleTelegramWebhook(makeRequest("secret"), env, ctx)).status, 200);
  assert.equal(queued.inputUrl, input);
  assert.equal(queued.chatId, 123);
  assert.equal(queued.telegramUserId, 456);
});
test("mocked Telegram job sends progress, card, and separate affiliate copy", async () => {
  const original = global.fetch;
  const sent = [];
  let screenshotCalls = 0;
  let aiCalls = 0;
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  try {
    global.fetch = async function (url, init) {
      assert.equal(this, globalThis);
      const address = String(url);
      if (address.startsWith("https://api.telegram.org/")) {
        const method = address.split("/").pop();
        sent.push({ method, body: method === "sendMessage" ? JSON.parse(init.body) : init.body });
        return Response.json({ ok: true });
      }
      if (address.startsWith("https://cloudflare-dns.com/")) return Response.json({ Status: 0, Answer: address.endsWith("type=A") ? [{ type: 1, data: "1.1.1.1" }] : [] });
      if (address === input) return new Response(null, { status: 302, headers: { location: walmart } });
      if (address === walmart) return new Response(withWas, { headers: { "content-type": "text/html" } });
      if (address.includes("walmartimages.com")) return new Response(png, { headers: { "content-type": "image/png" } });
      throw new Error(`Unexpected fetch: ${address}`);
    };
    const env = { TELEGRAM_BOT_TOKEN: "test-token", AI_TEXT_MODEL: "@cf/meta/llama-3.2-3b-instruct", AI: { run: async (model, options) => { aiCalls++; assert.equal(model, "@cf/meta/llama-3.2-3b-instruct"); assert.ok(!JSON.stringify(options).includes(input)); return { response: JSON.stringify({ shortTitle: "Disney Toniebox Starter Set", facebookBody: "Disney Toniebox Starter Set is now $59.00, was $99.00." }) }; } }, AFFILIATE_DISCLOSURE: "#Ad", BROWSER: { quickAction: async (action, options) => { screenshotCalls++; assert.equal(action, "screenshot"); assert.ok(options.html.includes("data:image/png;base64,")); assert.ok(!options.html.includes(input)); return new Response(png, { headers: { "content-type": "image/png" } }); } } };
    await processTelegramJob({ chatId: 123, inputUrl: input, telegramUserId: 456, requestId: "end-to-end-test" }, env);
    assert.deepEqual(sent.map(x => x.method), ["sendMessage", "sendPhoto", "sendMessage"]);
    assert.match(sent[0].body.text, /Creating your product card/);
    assert.ok(sent[2].body.text.endsWith(input));
    assert.equal(screenshotCalls, 1);
    assert.equal(aiCalls, 1);
  } finally { global.fetch = original; }
});
