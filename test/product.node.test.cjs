const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const src = path => require(join(process.env.COMPILED_ROOT, path));
const { detectStore } = src("stores/detect-store.js");
const { validatePublicUrl, assertPublicDns, findProductUrl } = src("stores/safe-url.js");
const { resolveUrl } = src("stores/resolve-url.js");
const { extractWalmartProduct } = src("stores/walmart/extractor.js");
const { inspectWalmartHtml } = src("stores/walmart/diagnostics.js");
const { normalizePrice } = src("stores/walmart/price.js");
const { parseCopyDraft, parseWorkersAIResponse, WorkersAICopyProvider } = src("ai/workers-ai-provider.js");
const { generateProductCopy } = src("ai/generate-product-copy.js");
const { walmartCardHtml } = src("stores/walmart/template.js");
const { BrowserScreenshotRenderer, browserRateLimitDelayMs } = src("rendering/browser-renderer.js");
const { processProductLink } = src("orchestration/process-product-link.js");
const { handleTelegramWebhook, processTelegramJob } = src("telegram/webhook.js");
const withWas = readFileSync("test/fixtures/walmart-with-was.html", "utf8");
const currentOnly = readFileSync("test/fixtures/walmart-current-only.html", "utf8");
const input = "https://affiliate.example.org/go?id=abc";
const walmart = "https://www.walmart.com/ip/123";

test("production and smoke Queue consumers use installed Wrangler max_concurrency schema", () => {
  const schema = JSON.parse(readFileSync("node_modules/wrangler/config-schema.json", "utf8"));
  const consumerProperties = schema.definitions.RawConfig.properties.queues.properties.consumers.items.properties;
  assert.deepEqual(consumerProperties.max_concurrency.type, ["number", "null"]);
  for (const [file, queue, maxConcurrency] of [["wrangler.jsonc", "affiliate-deal-card-jobs", 5], ["wrangler.smoke.jsonc", "affiliate-deal-card-smoke-jobs", 1]]) {
    const config = JSON.parse(readFileSync(file, "utf8"));
    assert.deepEqual(config.queues.consumers, [{ queue, max_batch_size: 1, max_batch_timeout: 1, max_concurrency: maxConcurrency }]);
    assert.equal(config.queues.producers[0].queue, queue);
  }
});

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
  assert.equal(page.redirectCount, 1);
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
  const html = `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { product: { usItemId: "123", name: "Toniebox Elsa", imageUrl: "https://i5.walmartimages.com/seo/test.jpg", priceInfo: { currentPrice: { price: 59 }, wasPrice: { price: 99 } } } } } })}</script>`;
  const p = extractWalmartProduct(html, input, walmart);
  assert.equal(p.rawTitle, "Toniebox Elsa");
  assert.equal(p.oldPrice.value, 99);
});

function walmartSimpleProductFixture(overrides = {}) {
  const product = {
    usItemId: "19658170815",
    id: "52HQJSZFHM45",
    displayVariantProductId: "52HQJSZFHM45",
    name: "Ozark Trail Disposable Instant Charcoal Grill 1 lb. Charcoal Content",
    model: "32500LIS",
    canonicalUrl: "/ip/Ozark-Trail-Grill/19658170815",
    imageInfo: { thumbnailUrl: "https://i5.walmartimages.com/ozark.jpeg" },
    priceInfo: { currentPrice: { price: 9.88, currencyUnit: "USD" } },
    ...overrides
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { data: { product } } } } })}</script>`;
}

const ozarkUrl = "https://www.walmart.com/ip/Ozark-Trail-Grill/19658170815";

test("Walmart simple root product is accepted without artificial selected-variant mappings", () => {
  const p = extractWalmartProduct(walmartSimpleProductFixture(), input, ozarkUrl);
  assert.equal(p.rawTitle, "Ozark Trail Disposable Instant Charcoal Grill 1 lb. Charcoal Content");
  assert.equal(p.currentPrice.value, 9.88);
  assert.equal(p.imageUrl, "https://i5.walmartimages.com/ozark.jpeg");
  assert.equal(p.canonicalProductUrl, ozarkUrl);
});

test("Walmart simple product still requires root and canonical identity to match the URL", () => {
  assert.throws(() => extractWalmartProduct(walmartSimpleProductFixture({ usItemId: "999" }), input, ozarkUrl), { code: "WALMART_VARIANT_MISMATCH" });
  assert.throws(() => extractWalmartProduct(walmartSimpleProductFixture({ canonicalUrl: "/ip/other/999" }), input, ozarkUrl), { code: "WALMART_VARIANT_MISMATCH" });
});

test("Walmart unknown multi-variant state without a selected product fails closed", () => {
  const variantsMap = {
    FIRST: { id: "FIRST", usItemId: "19658170815", priceInfo: { currentPrice: { price: 1 } } },
    SECOND: { id: "SECOND", usItemId: "2", priceInfo: { currentPrice: { price: 2 } } }
  };
  assert.throws(() => extractWalmartProduct(walmartSimpleProductFixture({ displayVariantProductId: undefined, variantsMap }), input, ozarkUrl), { code: "WALMART_VARIANT_MISMATCH" });
});

function walmartVariantFixture(overrides = {}) {
  const blackId = "54IS2LOFD40O";
  const cyberspaceId = "27GHL5QK1BUW";
  const selected = {
    id: blackId,
    usItemId: "13162221820",
    variants: ["actual_color-black"],
    imageInfo: { thumbnailUrl: "https://i5.walmartimages.com/black.jpeg" },
    priceInfo: {
      currentPrice: { price: 79.99, priceString: "$79.99", currencyUnit: "USD" },
      wasPrice: { price: 89, priceString: "$89.00", currencyUnit: "USD" },
      listPrice: { price: 89, priceString: "$89.00", currencyUnit: "USD" }
    },
    ...(overrides.selected ?? {})
  };
  const sibling = {
    id: cyberspaceId,
    usItemId: "18533210828",
    variants: ["actual_color-cyberspace"],
    imageInfo: { thumbnailUrl: "https://i5.walmartimages.com/cyberspace.jpeg" },
    priceInfo: { currentPrice: { price: 79, currencyUnit: "USD" }, wasPrice: { price: 89, currencyUnit: "USD" } },
    ...(overrides.sibling ?? {})
  };
  const product = {
    usItemId: "13162221820",
    id: blackId,
    name: "Ninja Pods & Grounds Hot & Iced Single-Serve Coffee Maker, PB045, Black",
    model: "PB045",
    canonicalUrl: "/ip/Ninja-Coffee-Machine-PB045/13162221820",
    imageInfo: { thumbnailUrl: "https://i5.walmartimages.com/black.jpeg" },
    priceInfo: selected.priceInfo,
    displayVariantProductId: blackId,
    selectedVariantIds: ["actual_color-black"],
    variantProductIdMap: {
      "actual_color-black": blackId,
      "actual_color-cyberspace": cyberspaceId
    },
    variantsMap: { [cyberspaceId]: sibling, [blackId]: selected },
    ...(overrides.product ?? {})
  };
  const jsonLd = overrides.jsonLd === false ? "" : `<script type="application/ld+json">${JSON.stringify({
    "@type": "Product", name: "Ambiguous product family", image: "https://i5.walmartimages.com/family.jpeg",
    offers: { price: 1, priceCurrency: "USD", wasPrice: 2 }
  })}</script>`;
  return `${jsonLd}<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { data: { product } } } } })}</script>`;
}

const ninjaUrl = "https://www.walmart.com/ip/Ninja-Coffee-Machine-PB045/13162221820";

test("Walmart PB045 Black resolves the selected internal variant and excludes the cheaper Cyberspace sibling", () => {
  const p = extractWalmartProduct(walmartVariantFixture(), input, ninjaUrl);
  assert.equal(p.rawTitle, "Ninja Pods & Grounds Hot & Iced Single-Serve Coffee Maker, PB045, Black");
  assert.equal(p.currentPrice.value, 79.99);
  assert.equal(p.oldPrice.value, 89);
  assert.equal(p.imageUrl, "https://i5.walmartimages.com/black.jpeg");
  assert.notEqual(p.currentPrice.value, 79);
  assert.notEqual(p.imageUrl, "https://i5.walmartimages.com/cyberspace.jpeg");
  assert.equal(p.postUrl, input);
});

test("Walmart selected variant mappings and URL item identity must agree", () => {
  assert.throws(() => extractWalmartProduct(walmartVariantFixture({ product: { usItemId: "18533210828" } }), input, ninjaUrl), { code: "WALMART_VARIANT_MISMATCH" });
  assert.throws(() => extractWalmartProduct(walmartVariantFixture({ product: { variantProductIdMap: { "actual_color-black": "27GHL5QK1BUW" } } }), input, ninjaUrl), { code: "WALMART_VARIANT_MISMATCH" });
  assert.throws(() => extractWalmartProduct(walmartVariantFixture({ selected: { usItemId: "18533210828" } }), input, ninjaUrl), { code: "WALMART_VARIANT_MISMATCH" });
});

test("Walmart selected variant price is unaffected by lower or higher sibling prices", () => {
  for (const siblingPrice of [1, 79, 999]) {
    const html = walmartVariantFixture({ sibling: { priceInfo: { currentPrice: { price: siblingPrice, currencyUnit: "USD" } } } });
    assert.equal(extractWalmartProduct(html, input, ninjaUrl).currentPrice.value, 79.99);
  }
});

test("Walmart selected variant accepts wasPrice, then listPrice, only when higher", () => {
  assert.equal(extractWalmartProduct(walmartVariantFixture(), input, ninjaUrl).oldPrice.value, 89);
  const listOnly = walmartVariantFixture({ selected: { priceInfo: {
    currentPrice: { price: 79.99, currencyUnit: "USD" }, listPrice: { price: 89, currencyUnit: "USD" }
  } } });
  assert.equal(extractWalmartProduct(listOnly, input, ninjaUrl).oldPrice.value, 89);
  for (const reference of [79.99, 70, 0]) {
    const html = walmartVariantFixture({ selected: { priceInfo: {
      currentPrice: { price: 79.99, currencyUnit: "USD" }, wasPrice: { price: reference, currencyUnit: "USD" }
    } } });
    assert.equal(extractWalmartProduct(html, input, ninjaUrl).oldPrice, undefined);
  }
});

test("ambiguous family JSON-LD cannot override validated Walmart selected variant price or image", () => {
  const p = extractWalmartProduct(walmartVariantFixture(), input, ninjaUrl);
  assert.equal(p.currentPrice.value, 79.99);
  assert.equal(p.imageUrl, "https://i5.walmartimages.com/black.jpeg");
  assert.notEqual(p.rawTitle, "Ambiguous product family");
});

function walmartAlternateVariantFixture(overrides = {}) {
  const selectedId = "4PUV4EGPQRNS";
  const siblingId = "OTHERPRODUCT";
  const selectedVariantIds = ["volume_capacity-26oz", "base_color-cyberspace"];
  const selected = {
    id: selectedId,
    usItemId: "18317156543",
    name: "Ninja BlendBOSS DB351CY Cyberspace 26 oz",
    model: "DB351CY",
    variants: selectedVariantIds,
    imageInfo: { thumbnailUrl: "https://i5.walmartimages.com/blendboss-cyberspace.jpeg" },
    priceInfo: { currentPrice: { price: 129.97, currencyUnit: "USD" }, wasPrice: { price: 129.99, currencyUnit: "USD" } },
    ...(overrides.selected ?? {})
  };
  const sibling = {
    id: siblingId,
    usItemId: "999999",
    variants: ["volume_capacity-32oz", "base_color-black"],
    imageInfo: { thumbnailUrl: "https://i5.walmartimages.com/sibling.jpeg" },
    priceInfo: { currentPrice: { price: 49, currencyUnit: "USD" } },
    ...(overrides.sibling ?? {})
  };
  const product = {
    usItemId: "18317156543",
    id: selectedId,
    displayVariantProductId: selectedId,
    selectedVariantIds,
    variantProductIdMap: {},
    variantsMap: { [siblingId]: sibling, [selectedId]: selected },
    canonicalUrl: "/ip/Ninja-BlendBOSS/18317156543",
    name: selected.name,
    imageInfo: selected.imageInfo,
    priceInfo: selected.priceInfo,
    ...(overrides.product ?? {})
  };
  return `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { initialData: { data: { product } } } } })}</script>`;
}

const blendBossUrl = "https://www.walmart.com/ip/Ninja-BlendBOSS/18317156543";

test("Walmart alternate selected-product shape ties BlendBOSS attributes and item identity to the displayed record", () => {
  const p = extractWalmartProduct(walmartAlternateVariantFixture(), input, blendBossUrl);
  assert.equal(p.rawTitle, "Ninja BlendBOSS DB351CY Cyberspace 26 oz");
  assert.equal(p.currentPrice.value, 129.97);
  assert.equal(p.oldPrice.value, 129.99);
  assert.equal(p.imageUrl, "https://i5.walmartimages.com/blendboss-cyberspace.jpeg");
  const identityOnly = extractWalmartProduct(walmartAlternateVariantFixture({ selected: { variants: undefined } }), input, blendBossUrl);
  assert.equal(identityOnly.currentPrice.value, 129.97);
});

test("Walmart alternate selected-product shape rejects identity conflicts and never consumes sibling fields", () => {
  assert.throws(() => extractWalmartProduct(walmartAlternateVariantFixture({ selected: { usItemId: "999999" } }), input, blendBossUrl), { code: "WALMART_VARIANT_MISMATCH" });
  assert.throws(() => extractWalmartProduct(walmartAlternateVariantFixture({ selected: { variants: ["base_color-black"] } }), input, blendBossUrl), { code: "WALMART_VARIANT_MISMATCH" });
  assert.throws(() => extractWalmartProduct(walmartAlternateVariantFixture({
    selected: { variants: undefined }, product: { id: "FAMILYPRODUCT" }
  }), input, blendBossUrl), { code: "WALMART_VARIANT_MISMATCH" });
  const p = extractWalmartProduct(walmartAlternateVariantFixture({ sibling: {
    imageInfo: { thumbnailUrl: "https://i5.walmartimages.com/wrong.jpeg" },
    priceInfo: { currentPrice: { price: 1, currencyUnit: "USD" } }
  } }), input, blendBossUrl);
  assert.equal(p.currentPrice.value, 129.97);
  assert.equal(p.imageUrl, "https://i5.walmartimages.com/blendboss-cyberspace.jpeg");
});
test("normal Walmart fixtures expose only safe title-source diagnostics", () => {
  assert.deepEqual(inspectWalmartHtml(withWas, walmart), {
    canonicalProductId: "123",
    hasJsonLdProduct: true,
    hasNextData: false,
    hasOgTitle: false,
    hasStandardTitleOrProductMeta: false,
    challengeDetected: false
  });
  const og = inspectWalmartHtml(currentOnly, walmart);
  assert.equal(og.hasJsonLdProduct, false);
  assert.equal(og.hasOgTitle, true);
  assert.equal(og.challengeDetected, false);
  const nextData = `<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script>`;
  assert.equal(inspectWalmartHtml(nextData, walmart).hasNextData, true);
});
test("missing-title and Walmart challenge pages are identified without supplying a title", () => {
  const missing = "<!doctype html><html><head></head><body>Unavailable</body></html>";
  assert.deepEqual(inspectWalmartHtml(missing, walmart), {
    canonicalProductId: "123",
    hasJsonLdProduct: false,
    hasNextData: false,
    hasOgTitle: false,
    hasStandardTitleOrProductMeta: false,
    challengeDetected: false
  });
  assert.throws(() => extractWalmartProduct(missing, input, walmart), { code: "MISSING_TITLE" });
  const challenge = "<!doctype html><html><head><title>Robot or human?</title></head><body>Please press and hold to verify you're a human.</body></html>";
  const diagnostic = inspectWalmartHtml(challenge, walmart);
  assert.equal(diagnostic.hasStandardTitleOrProductMeta, true);
  assert.equal(diagnostic.hasOgTitle, false);
  assert.equal(diagnostic.challengeDetected, true);
  assert.throws(() => extractWalmartProduct(challenge, input, walmart), { code: "MISSING_TITLE" });
});
test("MISSING_TITLE logs fetched-page metadata immediately before failure without leaking HTML or affiliate URL", async () => {
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  const secretMarker = "SECRET_CUSTOMER_INFORMATION";
  const challenge = `<!doctype html><html><head><title>Robot or human?</title><link rel="canonical" href="${walmart}?tracking=SECRET"></head><body>Press and hold — ${secretMarker} ${input}</body></html>`;
  try {
    console.log = line => logs.push(JSON.parse(line));
    console.error = line => logs.push(JSON.parse(line));
    let fetches = 0;
    await assert.rejects(processProductLink(input, {
      fetcher: async () => {
        fetches++;
        return fetches === 1
          ? new Response(null, { status: 302, headers: { location: walmart } })
          : new Response(challenge, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      },
      dnsCheck: async () => {},
      copyProvider: { generate: async () => { throw new Error("AI should not run"); } },
      renderer: { screenshot: async () => { throw new Error("Browser should not run"); } },
      disclosure: "#Ad", requestId: "missing-title-test"
    }), { code: "MISSING_TITLE" });
    assert.equal(fetches, 2);
    const diagnostic = logs.find(item => item.event === "walmart_extraction_diagnostics");
    assert.equal(diagnostic.requestId, "missing-title-test");
    assert.equal(diagnostic.httpStatus, 200);
    assert.equal(diagnostic.contentType, "text/html");
    assert.equal(diagnostic.responseByteLength, Buffer.byteLength(challenge, "utf8"));
    assert.ok(diagnostic.responseByteLength > diagnostic.htmlLength);
    assert.equal(diagnostic.htmlLength, challenge.length);
    assert.equal(diagnostic.hostname, "www.walmart.com");
    assert.equal(diagnostic.redirectCount, 1);
    assert.equal(diagnostic.canonicalProductId, "123");
    assert.equal(diagnostic.hasJsonLdProduct, false);
    assert.equal(diagnostic.hasNextData, false);
    assert.equal(diagnostic.hasOgTitle, false);
    assert.equal(diagnostic.hasStandardTitleOrProductMeta, true);
    assert.equal(diagnostic.challengeDetected, true);
    const failureIndex = logs.findIndex(item => item.event === "process_failed");
    assert.equal(logs[failureIndex - 1].event, "walmart_extraction_diagnostics");
    assert.equal(logs[failureIndex].errorCode, "MISSING_TITLE");
    assert.ok(!JSON.stringify(logs).includes(input));
    assert.ok(!JSON.stringify(logs).includes("tracking=SECRET"));
    assert.ok(!JSON.stringify(logs).includes(secretMarker));
    assert.ok(!JSON.stringify(logs).includes("<!doctype html>"));
  } finally { console.log = originalLog; console.error = originalError; }
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
  assert.ok(html.includes('<main class="card">'));
  assert.ok(html.includes('<div class="image-area">'));
  assert.ok(html.includes('<div class="title-area">'));
  assert.ok(html.includes('<div class="price-row">'));
  assert.ok(html.includes('loading="eager" decoding="sync"'));
  assert.ok(html.includes("image.decode().then(markReady)"));
  assert.ok(!html.includes(input));
  assert.doesNotMatch(html, /https?:\/\/|@import|<link\b|<script[^>]+src\s*=|url\(\s*['"]?https?:/i);
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
      const renderer = new BrowserScreenshotRenderer({ quickAction: async () => new Response(null, { status }) }, async () => {}, () => 0);
      await assert.rejects(renderer.screenshot("<main></main>", 1200, 1200), error => {
        assert.equal(error.code, "BROWSER_ERROR");
        assert.equal(error.browserDiagnostics.browserStatus, status);
        assert.equal(error.browserDiagnostics.browserReason, reason);
        return true;
      });
    } finally { console.error = originalError; }
  }
});
test("Browser success uses one Quick Action and reports attemptsUsed 1", async () => {
  const originalLog = console.log;
  const logs = [];
  let calls = 0;
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  try {
    console.log = line => logs.push(JSON.parse(line));
    const renderer = new BrowserScreenshotRenderer({ quickAction: async () => { calls++; return new Response(png); } }, async () => { throw Error("unexpected wait"); });
    assert.deepEqual((await renderer.screenshot("<main></main>", 1200, 1200)).bytes, png);
    assert.equal(calls, 1);
    assert.equal(logs.find(item => item.event === "browser_render_complete").attemptsUsed, 1);
  } finally { console.log = originalLog; }
});
test("one 429 retries the same HTML once and logs safe attempt metadata", async () => {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const logs = [];
  const html = `<main><img src="data:image/png;base64,SECRET"><a href="${input}">product</a></main>`;
  const calls = [];
  const waits = [];
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  try {
    console.log = line => logs.push(JSON.parse(line));
    console.warn = line => logs.push(JSON.parse(line));
    const renderer = new BrowserScreenshotRenderer({ quickAction: async (action, options) => {
      calls.push({ action, options });
      return calls.length === 1
        ? new Response(JSON.stringify({ errors: [{ message: "Quick Actions rate limit exceeded" }] }), { status: 429, statusText: "Too Many Requests", headers: { "content-type": "application/json", "Retry-After": "2", "x-browser-ms-used": "0" } })
        : new Response(png);
    } }, async ms => { waits.push(ms); }, () => 0);
    assert.deepEqual((await renderer.screenshot(html, 1200, 1200, "retry-test")).bytes, png);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].action, "screenshot");
    assert.deepEqual(calls[0].options, calls[1].options);
    assert.equal(calls[0].options.html, html);
    assert.deepEqual(waits, [2000]);
    const failed = logs.find(item => item.event === "browser_render_attempt_failed");
    assert.equal(failed.requestId, "retry-test");
    assert.equal(failed.attempt, 1);
    assert.equal(failed.browserStatus, 429);
    assert.equal(failed.browserReason, "BROWSER_QUICK_ACTION_RATE_LIMIT");
    assert.equal(failed.browserMsUsed, 0);
    assert.equal(failed.retryScheduled, true);
    assert.equal(failed.retryDelayMs, 2000);
    assert.equal(logs.find(item => item.event === "browser_render_complete").attemptsUsed, 2);
    assert.ok(!JSON.stringify(logs).includes(input));
    assert.ok(!JSON.stringify(logs).includes("data:image"));
    assert.ok(!JSON.stringify(logs).includes("SECRET"));
  } finally { console.log = originalLog; console.warn = originalWarn; }
});
test("unknown 429 without Retry-After uses short Paid fallback and retries once", async () => {
  const originalLog = console.log;
  const originalWarn = console.warn;
  const logs = [];
  const waits = [];
  let calls = 0;
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  try {
    console.log = line => logs.push(JSON.parse(line));
    console.warn = line => logs.push(JSON.parse(line));
    const renderer = new BrowserScreenshotRenderer({ quickAction: async () => {
      calls++;
      return calls === 1 ? new Response(null, { status: 429 }) : new Response(png);
    } }, async ms => { waits.push(ms); }, () => 0);
    assert.deepEqual((await renderer.screenshot("<main></main>", 1200, 1200)).bytes, png);
    assert.equal(calls, 2);
    assert.deepEqual(waits, [1000]);
    assert.equal(logs.find(item => item.event === "browser_render_attempt_failed").browserReason, "BROWSER_RATE_LIMIT");
    assert.equal(logs.find(item => item.event === "browser_render_complete").attemptsUsed, 2);
  } finally { console.log = originalLog; console.warn = originalWarn; }
});
test("explicit Browser usage-limit 429 fails without retry or leaking response content", async () => {
  const originalError = console.error;
  const originalWarn = console.warn;
  const logs = [];
  let calls = 0;
  const secret = "SECRET_BROWSER_BODY";
  try {
    console.error = line => logs.push(JSON.parse(line));
    console.warn = line => logs.push(JSON.parse(line));
    const renderer = new BrowserScreenshotRenderer({ quickAction: async () => {
      calls++;
      return new Response(JSON.stringify({ errors: [{ message: `Browser time limit exceeded for today ${secret} ${input} data:image/png;base64,PRIVATE` }] }), {
        status: 429, headers: { "content-type": "application/json", "Retry-After": "5" }
      });
    } }, async () => { throw Error("unexpected wait"); });
    await assert.rejects(renderer.screenshot(`<main>${secret} ${input}</main>`, 1200, 1200), error => {
      assert.equal(error.code, "BROWSER_ERROR");
      assert.equal(error.browserDiagnostics.browserReason, "BROWSER_USAGE_LIMIT");
      return true;
    });
    assert.equal(calls, 1);
    const attempt = logs.find(item => item.event === "browser_render_attempt_failed");
    assert.equal(attempt.browserReason, "BROWSER_USAGE_LIMIT");
    assert.equal(attempt.retryScheduled, false);
    assert.equal(attempt.retryDelayMs, undefined);
    assert.equal(logs.find(item => item.event === "browser_render_failed").browserReason, "BROWSER_USAGE_LIMIT");
    assert.ok(!JSON.stringify(logs).includes(secret));
    assert.ok(!JSON.stringify(logs).includes(input));
    assert.ok(!JSON.stringify(logs).includes("data:image"));
  } finally { console.error = originalError; console.warn = originalWarn; }
});
test("two 429 responses stop after two attempts with final rate-limit diagnostics", async () => {
  const originalError = console.error;
  const originalWarn = console.warn;
  const logs = [];
  let calls = 0;
  const waits = [];
  try {
    console.error = line => logs.push(JSON.parse(line));
    console.warn = line => logs.push(JSON.parse(line));
    const renderer = new BrowserScreenshotRenderer({ quickAction: async () => {
      calls++;
      return new Response(JSON.stringify({ errors: [{ message: "Too many requests" }] }), { status: 429, statusText: "Too Many Requests", headers: { "content-type": "application/json", "Retry-After": "1", "x-browser-ms-used": String(calls) } });
    } }, async ms => { waits.push(ms); }, () => 0);
    await assert.rejects(renderer.screenshot("<main></main>", 1200, 1200), error => {
      assert.equal(error.code, "BROWSER_ERROR");
      assert.equal(error.browserDiagnostics.browserStatus, 429);
      assert.equal(error.browserDiagnostics.browserReason, "BROWSER_QUICK_ACTION_RATE_LIMIT");
      assert.equal(error.browserDiagnostics.browserMsUsed, 2);
      return true;
    });
    assert.equal(calls, 2);
    assert.deepEqual(waits, [1000]);
    assert.deepEqual(logs.filter(item => item.event === "browser_render_attempt_failed").map(item => [item.attempt, item.retryScheduled]), [[1, true], [2, false]]);
    assert.equal(logs.find(item => item.event === "browser_render_failed").browserReason, "BROWSER_QUICK_ACTION_RATE_LIMIT");
  } finally { console.error = originalError; console.warn = originalWarn; }
});
test("only HTTP 429 retries; timeout, bad request, and malformed PNG do not", async () => {
  const originalError = console.error;
  const originalWarn = console.warn;
  try {
    console.error = () => {};
    console.warn = () => {};
    for (const [status, body, reason] of [[422, JSON.stringify({ errors: [{ message: "Navigation timeout" }] }), "BROWSER_TIMEOUT"], [400, null, "BROWSER_BAD_REQUEST"], [503, null, "BROWSER_SERVICE_UNAVAILABLE"]]) {
      let calls = 0;
      const renderer = new BrowserScreenshotRenderer({ quickAction: async () => {
        calls++;
        return new Response(body, { status, headers: body ? { "content-type": "application/json" } : undefined });
      } }, async () => { throw Error("unexpected wait"); });
      await assert.rejects(renderer.screenshot("<main></main>", 1200, 1200), error => error.browserDiagnostics.browserReason === reason);
      assert.equal(calls, 1);
    }
    let calls = 0;
    const renderer = new BrowserScreenshotRenderer({ quickAction: async () => { calls++; return new Response("not a PNG"); } }, async () => { throw Error("unexpected wait"); });
    await assert.rejects(renderer.screenshot("<main></main>", 1200, 1200), { code: "BROWSER_BAD_IMAGE" });
    assert.equal(calls, 1);
  } finally { console.error = originalError; console.warn = originalWarn; }
});
test("Retry-After integer is bounded, malformed values fall back, and jitter stays small", () => {
  assert.equal(browserRateLimitDelayMs("2", 0), 2000);
  assert.equal(browserRateLimitDelayMs("0", 0), 500);
  assert.equal(browserRateLimitDelayMs("999999", 0), 5000);
  assert.equal(browserRateLimitDelayMs("999999999999999999999999999999", 0), 5000);
  assert.equal(browserRateLimitDelayMs("not a number", 0), 1000);
  assert.equal(browserRateLimitDelayMs(null, 0), 1000);
  assert.equal(browserRateLimitDelayMs("2", 1), 2250);
  assert.equal(browserRateLimitDelayMs("5", 1), 5000);
});
test("Cloudflare 422 timeout response still maps to BROWSER_TIMEOUT", async () => {
  const originalError = console.error;
  try {
    console.error = () => {};
    const renderer = new BrowserScreenshotRenderer({ quickAction: async () => new Response(JSON.stringify({ success: false, errors: [{ message: "Navigation timeout" }] }), { status: 422, statusText: "Unprocessable Entity", headers: { "content-type": "application/json", "x-browser-ms-used": "0" } }) });
    await assert.rejects(renderer.screenshot("<main></main>", 1200, 1200), error => {
      assert.equal(error.code, "BROWSER_ERROR");
      assert.equal(error.browserDiagnostics.browserReason, "BROWSER_TIMEOUT");
      assert.equal(error.browserDiagnostics.browserStatus, 422);
      assert.equal(error.browserDiagnostics.browserMsUsed, 0);
      return true;
    });
  } finally { console.error = originalError; }
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
  let submittedHtml = "";
  try {
    console.log = line => logs.push(JSON.parse(line));
    console.error = line => logs.push(JSON.parse(line));
    const renderer = new BrowserScreenshotRenderer({ quickAction: async (action, options) => {
      assert.equal(action, "screenshot");
      submittedHtml = options.html;
      assert.deepEqual(options.gotoOptions, { waitUntil: "domcontentloaded", timeout: 8000 });
      assert.deepEqual(options.waitForSelector, { selector: '.card[data-card-ready="true"]', visible: true, timeout: 5000 });
      assert.equal(options.selector, '.card[data-card-ready="true"]');
      assert.equal(options.setJavaScriptEnabled, true);
      assert.equal(options.actionTimeout, 8000);
      assert.equal(options.bestAttempt, true);
      assert.equal(options.waitForTimeout, undefined);
      assert.deepEqual(options.screenshotOptions, { type: "png" });
      assert.deepEqual(options.viewport, { width: 1200, height: 1200 });
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
    const extraction = logs.find(item => item.event === "walmart_extraction_diagnostics");
    assert.equal(extraction.httpStatus, 200);
    assert.equal(extraction.contentType, "text/html");
    assert.equal(extraction.responseByteLength, Buffer.byteLength(withWas, "utf8"));
    assert.equal(extraction.redirectCount, 1);
    assert.equal(extraction.hasJsonLdProduct, true);
    assert.equal(extraction.hasNextData, false);
    assert.equal(extraction.hasOgTitle, false);
    assert.equal(extraction.challengeDetected, false);
    assert.deepEqual(result.card.bytes, png);
    assert.match(submittedHtml, /<img src="data:image\/png;base64,[A-Za-z0-9+/=]+"/);
    assert.ok(submittedHtml.includes("image.decode().then(markReady)"));
    assert.ok(!submittedHtml.includes(input));
    assert.doesNotMatch(submittedHtml, /https?:\/\/|@import|<link\b|<script[^>]+src\s*=|url\(\s*['"]?https?:/i);
    assert.equal(logs.find(item => item.event === "extraction_complete").canonicalProductId, "123");
    assert.equal(logs.find(item => item.event === "extraction_complete").hostname, "www.walmart.com");
    const image = logs.find(item => item.event === "product_image_downloaded");
    assert.equal(image.hostname, "i5.walmartimages.com");
    assert.equal(image.mimeType, "image/png");
    assert.equal(image.imageByteLength, png.byteLength);
    assert.match(image.imageFingerprint, /^[a-f0-9]{16}$/);
    const started = logs.find(item => item.event === "browser_render_started");
    assert.equal(started.htmlLength, submittedHtml.length);
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
test("two Browser 429s send one generic Telegram failure without repeating upstream work", async () => {
  const originalFetch = global.fetch;
  const originalError = console.error;
  const originalWarn = console.warn;
  const errors = [];
  const sent = [];
  const fetchCounts = { redirect: 0, page: 0, image: 0 };
  let aiCalls = 0;
  let browserCalls = 0;
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  try {
    console.error = line => errors.push(JSON.parse(line));
    console.warn = () => {};
    global.fetch = async function (url, init) {
      assert.equal(this, globalThis);
      const address = String(url);
      if (address.startsWith("https://api.telegram.org/")) {
        sent.push({ method: address.split("/").at(-1), body: JSON.parse(init.body) });
        return Response.json({ ok: true });
      }
      if (address.startsWith("https://cloudflare-dns.com/")) return Response.json({ Status: 0, Answer: address.endsWith("type=A") ? [{ type: 1, data: "1.1.1.1" }] : [] });
      if (address === input) { fetchCounts.redirect++; return new Response(null, { status: 302, headers: { location: walmart } }); }
      if (address === walmart) { fetchCounts.page++; return new Response(withWas, { headers: { "content-type": "text/html" } }); }
      if (address.includes("walmartimages.com")) { fetchCounts.image++; return new Response(png, { headers: { "content-type": "image/png" } }); }
      throw new Error("Unexpected fetch in Browser rate-limit test");
    };
    const env = {
      TELEGRAM_BOT_TOKEN: "test-token", AI_TEXT_MODEL: "@cf/meta/llama-3.2-3b-instruct",
      AI: { run: async () => { aiCalls++; return { response: JSON.stringify({ shortTitle: "Disney Toniebox Starter Set" }) }; } },
      AFFILIATE_DISCLOSURE: "#Ad",
      BROWSER: { quickAction: async () => { browserCalls++; return new Response(null, { status: 429, headers: { "Retry-After": "0" } }); } }
    };
    await processTelegramJob({ chatId: 123, inputUrl: input, requestId: "browser-rate-limit-job" }, env);
    assert.deepEqual(fetchCounts, { redirect: 1, page: 1, image: 1 });
    assert.equal(aiCalls, 1);
    assert.equal(browserCalls, 2);
    assert.deepEqual(sent.map(item => item.method), ["sendMessage", "sendMessage"]);
    assert.equal(sent[1].body.text, "I found the product but couldn't generate the image.");
    assert.equal(errors.find(item => item.event === "job_processing_failed").browserReason, "BROWSER_RATE_LIMIT");
    assert.ok(!errors.some(item => item.event === "telegram_delivery_failed"));
    assert.ok(!JSON.stringify(errors).includes(input));
  } finally { global.fetch = originalFetch; console.error = originalError; console.warn = originalWarn; }
});
async function runTelegramDeliveryCase(reply, requestId) {
  const originalFetch = global.fetch;
  const originalLog = console.log;
  const originalError = console.error;
  const logs = [];
  const errors = [];
  const sent = [];
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  try {
    console.log = line => logs.push(JSON.parse(line));
    console.error = line => errors.push(JSON.parse(line));
    global.fetch = async function (url, init) {
      assert.equal(this, globalThis);
      const address = String(url);
      if (address.startsWith("https://api.telegram.org/")) {
        const method = address.split("/").at(-1);
        const body = method === "sendMessage" ? JSON.parse(init.body) : undefined;
        sent.push({ method, body });
        return reply(method, body, sent.length);
      }
      if (address.startsWith("https://cloudflare-dns.com/")) return Response.json({ Status: 0, Answer: address.endsWith("type=A") ? [{ type: 1, data: "1.1.1.1" }] : [] });
      if (address === input) return new Response(null, { status: 302, headers: { location: walmart } });
      if (address === walmart) return new Response(withWas, { headers: { "content-type": "text/html" } });
      if (address.includes("walmartimages.com")) return new Response(png, { headers: { "content-type": "image/png" } });
      throw new Error("Unexpected fetch in Telegram delivery test");
    };
    const env = {
      TELEGRAM_BOT_TOKEN: "test-token", AI_TEXT_MODEL: "@cf/meta/llama-3.2-3b-instruct",
      AI: { run: async () => ({ response: JSON.stringify({ shortTitle: "Disney Toniebox Starter Set" }) }) },
      AFFILIATE_DISCLOSURE: "#Ad",
      BROWSER: { quickAction: async () => new Response(png, { headers: { "content-type": "image/png" } }) }
    };
    await processTelegramJob({ chatId: 123, inputUrl: input, requestId }, env);
    return { sent, logs, errors };
  } finally { global.fetch = originalFetch; console.log = originalLog; console.error = originalError; }
}

test("failed progress status is nonessential; photo and copy still deliver", async () => {
  const { sent, logs, errors } = await runTelegramDeliveryCase((method, body, call) =>
    call === 1 ? Response.json({ ok: false, error_code: 429, description: "Too Many Requests: retry after 1" }, { status: 429 }) : Response.json({ ok: true }), "progress-failure-test");
  assert.deepEqual(sent.map(item => item.method), ["sendMessage", "sendPhoto", "sendMessage"]);
  assert.equal(errors.find(item => item.event === "telegram_delivery_failed").operation, "send_progress");
  assert.equal(errors.find(item => item.event === "telegram_delivery_failed").telegramDescriptionCategory, "RATE_LIMIT");
  assert.equal(logs.find(item => item.event === "process_complete").success, true);
  assert.ok(logs.some(item => item.event === "telegram_photo_sent"));
  assert.ok(logs.some(item => item.event === "telegram_copy_sent"));
  assert.ok(!errors.some(item => item.event === "job_processing_failed"));
});

test("photo delivery failure reports image delivery, not card creation", async () => {
  const { sent, logs, errors } = await runTelegramDeliveryCase(method => method === "sendPhoto"
    ? Response.json({ ok: false, error_code: 413, description: "Request Entity Too Large" }, { status: 413 })
    : Response.json({ ok: true }), "photo-failure-test");
  assert.deepEqual(sent.map(item => item.method), ["sendMessage", "sendPhoto", "sendMessage"]);
  assert.equal(sent[2].body.text, "Your card was created, but I couldn't send the image. Please try again.");
  assert.ok(logs.some(item => item.event === "process_complete" && item.success === true));
  assert.ok(!logs.some(item => item.event === "telegram_copy_sent"));
  const failure = errors.find(item => item.event === "telegram_delivery_failed");
  assert.deepEqual({ operation: failure.operation, httpStatus: failure.httpStatus, telegramErrorCode: failure.telegramErrorCode, telegramDescriptionCategory: failure.telegramDescriptionCategory },
    { operation: "send_photo", httpStatus: 413, telegramErrorCode: 413, telegramDescriptionCategory: "FILE_TOO_LARGE" });
  assert.ok(!JSON.stringify(errors).includes(input));
  assert.ok(!JSON.stringify(errors).includes("telegramUserId"));
});

test("copy delivery failure preserves sent photo and reports only copy failure", async () => {
  const { sent, logs, errors } = await runTelegramDeliveryCase((method, body) => method === "sendMessage" && body.text.startsWith("✅ Facebook post:")
    ? Response.json({ ok: false, error_code: 400, description: "Bad Request: message is too long" }, { status: 400 })
    : Response.json({ ok: true }), "copy-failure-test");
  assert.deepEqual(sent.map(item => item.method), ["sendMessage", "sendPhoto", "sendMessage", "sendMessage"]);
  assert.equal(sent[3].body.text, "Your card was sent, but I couldn't send the Facebook post text. Please try again.");
  assert.ok(logs.some(item => item.event === "telegram_photo_sent"));
  assert.ok(!logs.some(item => item.event === "telegram_copy_sent"));
  assert.ok(logs.some(item => item.event === "process_complete" && item.success === true));
  const failure = errors.find(item => item.event === "telegram_delivery_failed");
  assert.equal(failure.operation, "send_copy");
  assert.equal(failure.httpStatus, 400);
  assert.equal(failure.telegramErrorCode, 400);
  assert.equal(failure.telegramDescriptionCategory, "MESSAGE_TOO_LONG");
  assert.ok(!errors.some(item => item.event === "job_processing_failed"));
  assert.ok(!JSON.stringify(errors).includes(input));
});

test("successful photo and copy delivery has no Telegram failure event", async () => {
  const { sent, logs, errors } = await runTelegramDeliveryCase(() => Response.json({ ok: true }), "delivery-success-test");
  assert.deepEqual(sent.map(item => item.method), ["sendMessage", "sendPhoto", "sendMessage"]);
  assert.ok(logs.some(item => item.event === "telegram_photo_sent"));
  assert.ok(logs.some(item => item.event === "telegram_copy_sent"));
  assert.ok(!errors.some(item => item.event === "telegram_delivery_failed"));
});
