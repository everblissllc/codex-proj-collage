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
const { BrowserScreenshotRenderer } = src("rendering/browser-renderer.js");
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
  assert.throws(() => parseCopyDraft({ shortTitle: "Now $59" }), { code: "AI_INVALID_CONTENT", validationReason: "AI_SHORT_TITLE_HAS_PRICE" });
  assert.throws(() => parseCopyDraft({ shortTitle: "Toniebox https://wrong.link" }), { code: "AI_INVALID_CONTENT", validationReason: "AI_SHORT_TITLE_HAS_URL" });
  assert.throws(() => parseCopyDraft({ shortTitle: "Disney Toniebox", facebookBody: "Buy" }), { code: "AI_INVALID_CONTENT", validationReason: "AI_UNEXPECTED_FIELD" });
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
    assert.ok(!JSON.stringify(options).includes(p.currentPrice.formatted));
    assert.ok(!JSON.stringify(options).includes(p.oldPrice.formatted));
    assert.equal(options.messages.length, 2);
    return { response: '```json\n{"shortTitle":"Disney Toniebox Starter Set"}\n```' };
  } }, "@cf/meta/llama-3.2-3b-instruct");
  const draft = await provider.generate(p);
  assert.equal(draft.shortTitle, "Disney Toniebox Starter Set");
  assert.equal(calls, 1);
  assert.throws(() => parseWorkersAIResponse({ response: { shortTitle: "Now $59" } }), { code: "AI_INVALID_CONTENT" });
});
test("current and old prices and exact affiliate URL are appended by code", async () => {
  const p = extractWalmartProduct(withWas, input, walmart);
  const copy = await generateProductCopy(p, { generate: async () => ({ shortTitle: "Disney Toniebox Starter Set" }) }, "#Ad");
  assert.equal(copy.facebookPost, `#Ad 🚨 Disney Toniebox Starter Set is now $59.00, was $99.00.\n\n👉 ${input}`);
  assert.ok(!copy.facebookPost.includes(walmart));
  assert.ok(!/daily wear|vacation trips|beach outings/i.test(copy.facebookPost));
});
test("current-only Facebook post is built exactly from source price and affiliate URL", async () => {
  const p = extractWalmartProduct(currentOnly, input, walmart);
  const copy = await generateProductCopy(p, { generate: async () => ({ shortTitle: "Disney Toniebox Starter Set" }) }, "#Ad");
  assert.equal(copy.facebookPost, `#Ad 🚨 Disney Toniebox Starter Set is now $59.00.\n\n👉 ${input}`);
});
const validAiDraft = { shortTitle: "Disney Toniebox Starter Set" };
const aiResponse = draft => ({ response: JSON.stringify(draft) });
function sequenceProvider(responses) {
  const requests = [];
  const provider = new WorkersAICopyProvider({ run: async (model, options) => {
    requests.push({ model, options });
    return responses[requests.length - 1];
  } }, "@cf/meta/llama-3.2-3b-instruct");
  return { provider, requests };
}
test("valid AI title succeeds after exactly one inference", async () => {
  const p = extractWalmartProduct(withWas, input, walmart);
  const { provider, requests } = sequenceProvider([aiResponse(validAiDraft)]);
  const content = await generateProductCopy(p, provider);
  assert.equal(content.attemptsUsed, 1);
  assert.equal(requests.length, 1);
  assert.ok(content.facebookPost.endsWith(input));
});
for (const [name, firstResponse, reason] of [
  ["malformed JSON", { response: "not json" }, "AI_BAD_JSON"],
  ["empty title", { response: "{}" }, "AI_SHORT_TITLE_EMPTY"],
  ["sales wording in title", aiResponse({ ...validAiDraft, shortTitle: "Now Disney Toniebox Starter Set" }), "AI_SHORT_TITLE_HAS_SALES_LANGUAGE"],
  ["price in title", aiResponse({ ...validAiDraft, shortTitle: "Disney Toniebox $59.00" }), "AI_SHORT_TITLE_HAS_PRICE"],
  ["URL in title", aiResponse({ ...validAiDraft, shortTitle: "Disney Toniebox https://wrong.example/item" }), "AI_SHORT_TITLE_HAS_URL"],
  ["lifestyle claim in title", aiResponse({ ...validAiDraft, shortTitle: "Midi Dress perfect for beach outings" }), "AI_SHORT_TITLE_HAS_PROMOTIONAL_CLAIM"],
  ["disclosure in title", aiResponse({ ...validAiDraft, shortTitle: "#Ad Disney Toniebox" }), "AI_SHORT_TITLE_HAS_DISCLOSURE"]
]) {
  test(`AI retries once after ${name} and sends no affiliate URL in either request`, async () => {
    const p = extractWalmartProduct(withWas, input, walmart);
    const { provider, requests } = sequenceProvider([firstResponse, aiResponse(validAiDraft)]);
    const failures = [];
    const content = await generateProductCopy(p, provider, "#Ad", failure => failures.push(failure));
    assert.equal(content.attemptsUsed, 2);
    assert.equal(requests.length, 2);
    assert.deepEqual(failures, [{ attempt: 1, errorCode: "AI_INVALID_CONTENT", validationReason: reason }]);
    assert.ok(requests[1].options.messages[2].content.includes(reason));
    assert.ok(requests.every(request => !JSON.stringify(request.options).includes(input)));
    assert.ok(requests.every(request => !JSON.stringify(request.options).includes(p.currentPrice.formatted)));
    assert.ok(requests.every(request => !JSON.stringify(request.options).includes(p.oldPrice.formatted)));
    assert.ok(content.facebookPost.endsWith(input));
  });
}
test("two malformed AI responses fail with AI_INVALID_CONTENT after exactly two attempts", async () => {
  const p = extractWalmartProduct(withWas, input, walmart);
  const { provider, requests } = sequenceProvider([{ response: "not json" }, { response: "still not json" }]);
  const failures = [];
  await assert.rejects(generateProductCopy(p, provider, "#Ad", failure => failures.push(failure)), { code: "AI_INVALID_CONTENT", validationReason: "AI_BAD_JSON" });
  assert.equal(requests.length, 2);
  assert.deepEqual(failures.map(failure => failure.attempt), [1, 2]);
});
test("two invalid titles still fail", async () => {
  const p = extractWalmartProduct(withWas, input, walmart);
  const invalid = aiResponse({ shortTitle: "Now Disney Toniebox" });
  const { provider, requests } = sequenceProvider([invalid, invalid]);
  await assert.rejects(generateProductCopy(p, provider), { code: "AI_INVALID_CONTENT", validationReason: "AI_SHORT_TITLE_HAS_SALES_LANGUAGE" });
  assert.equal(requests.length, 2);
});
test("Workers AI service failures are not retried as content errors", async () => {
  const p = extractWalmartProduct(withWas, input, walmart);
  let calls = 0;
  const provider = new WorkersAICopyProvider({ run: async () => { calls++; throw new Error("service unavailable"); } }, "@cf/meta/llama-3.2-3b-instruct");
  await assert.rejects(generateProductCopy(p, provider), { code: "AI_PROVIDER_FAILED" });
  assert.equal(calls, 1);
});
test("AI retry logs only safe reason and reports two attempts on success", async () => {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const logs = [];
  const responses = [new Response(null, { status: 302, headers: { location: walmart } }), new Response(withWas, { headers: { "content-type": "text/html" } }), new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { "content-type": "image/png" } })];
  try {
    console.log = line => logs.push(JSON.parse(line));
    console.warn = line => logs.push(JSON.parse(line));
    const { provider } = sequenceProvider([{ response: "not json" }, aiResponse(validAiDraft)]);
    await processProductLink(input, { fetcher: async () => responses.shift(), dnsCheck: async () => {}, copyProvider: provider, renderer: { screenshot: async () => ({ bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" }) }, disclosure: "#Ad", requestId: "ai-retry-log-test" });
    assert.deepEqual(logs.filter(item => item.event === "ai_attempt_failed").map(item => [item.attempt, item.errorCode, item.validationReason]), [[1, "AI_INVALID_CONTENT", "AI_BAD_JSON"]]);
    assert.equal(logs.find(item => item.event === "ai_complete").attemptsUsed, 2);
    assert.ok(!JSON.stringify(logs).includes(input));
  } finally { console.log = originalLog; console.warn = originalWarn; }
});
test("long title stays bounded and image aspect ratio is preserved", () => {
  const p = extractWalmartProduct(withWas, input, walmart);
  const html = walmartCardHtml(p, { shortTitle: "Disney Toniebox Starter Set with Elsa and Many More Description Words That Are Deliberately Long", facebookPost: "" }, "data:image/png;base64,AAAA");
  assert.ok(html.includes("font-size:49px"));
  assert.ok(html.includes("-webkit-line-clamp:3"));
  assert.ok(html.includes("object-fit:contain"));
  assert.ok(html.includes("$59.00"));
  assert.ok(html.includes("$99.00"));
});
test("non-2xx Browser Run response retains safe status and reason without logging response content", async () => {
  const originalError = console.error;
  const logs = [];
  const sensitiveHtml = `<img src="data:image/png;base64,SECRET"><a href="${input}">product</a>`;
  try {
    console.error = line => logs.push(JSON.parse(line));
    const browser = { quickAction: async (action, options) => {
      assert.equal(action, "screenshot");
      assert.equal(options.html, sensitiveHtml);
      return new Response(JSON.stringify({ success: false, errors: [{ message: `Navigation timeout at ${input} data:image/png;base64,SECRET` }] }), {
        status: 500, statusText: "Internal Server Error",
        headers: { "content-type": "application/json", "x-browser-ms-used": "30000" }
      });
    } };
    const renderer = new BrowserScreenshotRenderer(browser);
    await assert.rejects(renderer.screenshot(sensitiveHtml, 1200, 1200, "browser-error-test"), error => {
      assert.equal(error.code, "BROWSER_ERROR");
      assert.equal(error.browserDiagnostics.browserStatus, 500);
      assert.equal(error.browserDiagnostics.browserStatusText, "Internal Server Error");
      assert.equal(error.browserDiagnostics.browserMsUsed, 30000);
      assert.equal(error.browserDiagnostics.browserReason, "BROWSER_TIMEOUT");
      assert.equal(typeof error.browserDiagnostics.browserDurationMs, "number");
      return true;
    });
    assert.equal(logs[0].event, "browser_render_failed");
    assert.equal(logs[0].browserReason, "BROWSER_TIMEOUT");
    assert.ok(!JSON.stringify(logs).includes(input));
    assert.ok(!JSON.stringify(logs).includes("data:image"));
    assert.ok(!JSON.stringify(logs).includes("SECRET"));
  } finally { console.error = originalError; }
});
test("Browser Run status maps to safe rate-limit and service reasons", async () => {
  for (const [status, reason] of [[429, "BROWSER_RATE_LIMIT"], [503, "BROWSER_SERVICE_UNAVAILABLE"], [400, "BROWSER_BAD_REQUEST"], [422, "BROWSER_UNKNOWN_ERROR"]]) {
    const originalError = console.error;
    try {
      console.error = () => {};
      const renderer = new BrowserScreenshotRenderer({ quickAction: async () => new Response(null, { status }) });
      await assert.rejects(renderer.screenshot("<main></main>", 1200, 1200), error => {
        assert.equal(error.code, "BROWSER_ERROR");
        assert.equal(error.browserDiagnostics.browserStatus, status);
        assert.equal(error.browserDiagnostics.browserReason, reason);
        return true;
      });
    } finally { console.error = originalError; }
  }
});
test("nonstandard Browser status text is omitted from logs", async () => {
  const originalError = console.error;
  const logs = [];
  try {
    console.error = line => logs.push(JSON.parse(line));
    const renderer = new BrowserScreenshotRenderer({ quickAction: async () => new Response(null, { status: 500, statusText: `SECRET ${input}` }) });
    await assert.rejects(renderer.screenshot("<main></main>", 1200, 1200), { code: "BROWSER_ERROR" });
    assert.equal(logs[0].browserStatusText, undefined);
    assert.ok(!JSON.stringify(logs).includes(input));
    assert.ok(!JSON.stringify(logs).includes("SECRET"));
  } finally { console.error = originalError; }
});
test("render diagnostics compare image and HTML metadata without logging URLs or data URLs", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  const p = extractWalmartProduct(withWas, input, walmart);
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  let submittedHtmlLength = 0;
  try {
    console.log = line => logs.push(JSON.parse(line));
    console.error = line => logs.push(JSON.parse(line));
    const renderer = new BrowserScreenshotRenderer({ quickAction: async (action, options) => {
      assert.equal(action, "screenshot");
      submittedHtmlLength = options.html.length;
      return new Response(png, { headers: { "content-type": "image/png", "x-browser-ms-used": "12" } });
    } });
    const result = await processProductLink(input, {
      fetcher: async url => url === input
        ? new Response(null, { status: 302, headers: { location: walmart } })
        : url === walmart
          ? new Response(withWas, { headers: { "content-type": "text/html" } })
          : new Response(png, { headers: { "content-type": "image/png" } }),
      dnsCheck: async () => {},
      copyProvider: { generate: async () => ({ shortTitle: "Disney Toniebox Starter Set" }) },
      renderer, disclosure: "#Ad", requestId: "render-metadata-test"
    });
    assert.equal(result.card.mimeType, "image/png");
    assert.equal(logs.find(item => item.event === "extraction_complete").canonicalProductId, "123");
    assert.equal(logs.find(item => item.event === "extraction_complete").hostname, "www.walmart.com");
    const image = logs.find(item => item.event === "product_image_downloaded");
    assert.equal(image.hostname, "i5.walmartimages.com");
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.imageByteLength, png.byteLength);
    assert.match(image.imageFingerprint, /^[a-f0-9]{16}$/);
    const started = logs.find(item => item.event === "browser_render_started");
    assert.equal(started.htmlLength, submittedHtmlLength);
    assert.equal(started.embeddedImageMimeType, "image/png");
    assert.equal(started.embeddedImageByteLength, png.byteLength);
    assert.equal(started.width, 1200);
    assert.equal(started.height, 1200);
    const complete = logs.find(item => item.event === "browser_render_complete");
    assert.equal(complete.outputBytes, png.byteLength);
    assert.equal(complete.mimeType, "image/png");
    assert.equal(complete.browserMsUsed, 12);
    assert.equal(typeof complete.browserDurationMs, "number");
    assert.ok(!JSON.stringify(logs).includes(input));
    assert.ok(!JSON.stringify(logs).includes("data:image"));
    assert.ok(!JSON.stringify(logs).includes("<!doctype html>"));
  } finally { console.log = originalLog; console.error = originalError; }
});
test("render failure keeps Browser diagnostics in process_failed with measured render duration", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  try {
    console.log = line => logs.push(JSON.parse(line));
    console.error = line => logs.push(JSON.parse(line));
    const renderer = new BrowserScreenshotRenderer({ quickAction: async () => new Response(JSON.stringify({ success: false, errors: [{ message: "Navigation timed out" }] }), { status: 500, headers: { "content-type": "application/json" } }) });
    await assert.rejects(processProductLink(input, {
      fetcher: async url => url === input
        ? new Response(null, { status: 302, headers: { location: walmart } })
        : url === walmart
          ? new Response(withWas, { headers: { "content-type": "text/html" } })
          : new Response(png, { headers: { "content-type": "image/png" } }),
      dnsCheck: async () => {},
      copyProvider: { generate: async () => ({ shortTitle: "Disney Toniebox Starter Set" }) },
      renderer, disclosure: "#Ad", requestId: "render-failure-test"
    }), { code: "BROWSER_ERROR" });
    const failure = logs.find(item => item.event === "process_failed");
    assert.equal(failure.errorStage, "render");
    assert.equal(failure.errorCode, "BROWSER_ERROR");
    assert.equal(failure.browserStatus, 500);
    assert.equal(failure.browserReason, "BROWSER_TIMEOUT");
    assert.equal(typeof failure.browserDurationMs, "number");
    assert.equal(typeof failure.renderDurationMs, "number");
    assert.ok(!JSON.stringify(logs).includes(input));
    assert.ok(!JSON.stringify(logs).includes("data:image"));
  } finally { console.log = originalLog; console.error = originalError; }
});
test("unsupported store stops before AI and rendering", async () => {
  let called = false;
  await assert.rejects(processProductLink("https://example.org/item", { fetcher: async () => new Response("html"), dnsCheck: async () => {}, copyProvider: { generate: async () => { called = true; throw new Error(); } }, renderer: { screenshot: async () => { called = true; throw new Error(); } }, disclosure: "#Ad", requestId: "test" }), { code: "UNSUPPORTED_STORE" });
  assert.equal(called, false);
});
test("orchestration uses one page fetch and one image fetch", async () => {
  const responses = [new Response(null, { status: 302, headers: { location: walmart } }), new Response(withWas, { headers: { "content-type": "text/html" } }), new Response(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), { headers: { "content-type": "image/png" } })];
  const fetchedUrls = []; let renders = 0;
  const result = await processProductLink(input, { fetcher: async url => { fetchedUrls.push(url); return responses.shift(); }, dnsCheck: async () => {}, copyProvider: { generate: async () => ({ shortTitle: "Disney Toniebox Starter Set" }) }, renderer: { screenshot: async () => { renders++; return { bytes: new Uint8Array([137, 80, 78, 71]), mimeType: "image/png" }; } }, disclosure: "#Ad", requestId: "test" });
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
    const env = { TELEGRAM_BOT_TOKEN: "test-token", AI_TEXT_MODEL: "@cf/meta/llama-3.2-3b-instruct", AI: { run: async (model, options) => { aiCalls++; assert.equal(model, "@cf/meta/llama-3.2-3b-instruct"); assert.ok(!JSON.stringify(options).includes(input)); return { response: JSON.stringify({ shortTitle: "Disney Toniebox Starter Set" }) }; } }, AFFILIATE_DISCLOSURE: "#Ad", BROWSER: { quickAction: async (action, options) => { screenshotCalls++; assert.equal(action, "screenshot"); assert.ok(options.html.includes("data:image/png;base64,")); assert.ok(!options.html.includes(input)); return new Response(png, { headers: { "content-type": "image/png" } }); } } };
    await processTelegramJob({ chatId: 123, inputUrl: input, telegramUserId: 456, requestId: "end-to-end-test" }, env);
    assert.deepEqual(sent.map(x => x.method), ["sendMessage", "sendPhoto", "sendMessage"]);
    assert.match(sent[0].body.text, /Creating your product card/);
    assert.equal(sent[2].body.text, `✅ Facebook post:\n\n#Ad 🚨 Disney Toniebox Starter Set is now $59.00, was $99.00.\n\n👉 ${input}`);
    assert.equal(screenshotCalls, 1);
    assert.equal(aiCalls, 1);
  } finally { global.fetch = original; }
});
test("AI job failure logs processing failure, then sends generic Telegram error without a delivery-failure log", async () => {
  const originalFetch = global.fetch;
  const originalError = console.error;
  const originalWarn = console.warn;
  const errors = [];
  const warnings = [];
  const sent = [];
  let aiCalls = 0;
  try {
    console.error = line => errors.push(JSON.parse(line));
    console.warn = line => warnings.push(JSON.parse(line));
    global.fetch = async function (url, init) {
      assert.equal(this, globalThis);
      const address = String(url);
      if (address.startsWith("https://api.telegram.org/")) {
        sent.push(JSON.parse(init.body));
        return Response.json({ ok: true });
      }
      if (address.startsWith("https://cloudflare-dns.com/")) return Response.json({ Status: 0, Answer: address.endsWith("type=A") ? [{ type: 1, data: "1.1.1.1" }] : [] });
      if (address === input) return new Response(null, { status: 302, headers: { location: walmart } });
      if (address === walmart) return new Response(withWas, { headers: { "content-type": "text/html" } });
      throw new Error("Unexpected fetch in AI failure test");
    };
    const env = { TELEGRAM_BOT_TOKEN: "test-token", AI_TEXT_MODEL: "@cf/meta/llama-3.2-3b-instruct", AI: { run: async () => { aiCalls++; return { response: "not json" }; } }, AFFILIATE_DISCLOSURE: "#Ad" };
    await processTelegramJob({ chatId: 123, inputUrl: input, requestId: "processing-failure-test" }, env);
    assert.equal(aiCalls, 2);
    assert.equal(sent.length, 2);
    assert.equal(sent[1].text, "I found the product but couldn't generate the card text. Please try again.");
    assert.deepEqual(warnings.filter(item => item.event === "ai_attempt_failed").map(item => item.attempt), [1, 2]);
    assert.equal(errors.find(item => item.event === "process_failed").validationReason, "AI_BAD_JSON");
    assert.equal(typeof errors.find(item => item.event === "process_failed").aiDurationMs, "number");
    assert.equal(errors.find(item => item.event === "job_processing_failed").validationReason, "AI_BAD_JSON");
    assert.ok(!errors.some(item => item.event === "telegram_delivery_failed"));
    assert.ok(!JSON.stringify([...errors, ...warnings]).includes(input));
  } finally { global.fetch = originalFetch; console.error = originalError; console.warn = originalWarn; }
});
test("actual Telegram API failure logs telegram_delivery_failed, not job_processing_failed", async () => {
  const originalFetch = global.fetch;
  const originalError = console.error;
  const errors = [];
  let sendCalls = 0;
  try {
    console.error = line => errors.push(JSON.parse(line));
    global.fetch = async function (url) {
      assert.equal(this, globalThis);
      assert.match(String(url), /api\.telegram\.org/);
      sendCalls++;
      return sendCalls === 1 ? Response.json({ ok: false }, { status: 500 }) : Response.json({ ok: true });
    };
    await processTelegramJob({ chatId: 123, inputUrl: input, requestId: "telegram-failure-test" }, { TELEGRAM_BOT_TOKEN: "test-token" });
    assert.equal(sendCalls, 2);
    assert.equal(errors.find(item => item.event === "telegram_delivery_failed").operation, "progress_message");
    assert.ok(!errors.some(item => item.event === "job_processing_failed"));
  } finally { global.fetch = originalFetch; console.error = originalError; }
});
