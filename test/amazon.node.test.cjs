const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const src = path => require(join(process.env.COMPILED_ROOT, path));
const { detectStore } = src("stores/detect-store.js");
const { amazonAsinFromUrl, inspectAmazonHtml, usableAmazonHtml } = src("stores/amazon/diagnostics.js");
const { extractAmazonProduct } = src("stores/amazon/extractor.js");
const { amazonCardHtml } = src("stores/amazon/template.js");
const { BrowserAmazonPageLoader } = src("stores/amazon/page-loader.js");
const { processProductLink } = src("orchestration/process-product-link.js");
const { productStateCacheKey, AMAZON_TEMPLATE_VERSION } = src("cache/cache-key.js");

const sale = readFileSync("test/fixtures/amazon-sale.html", "utf8");
const regular = readFileSync("test/fixtures/amazon-current-only.html", "utf8");
const challenge = readFileSync("test/fixtures/amazon-challenge.html", "utf8");
const saleUrl = "https://www.amazon.com/dp/B08HNBHSQV";
const regularUrl = "https://www.amazon.com/gp/product/B00MNV8E0C";
const affiliate = "https://www.amazon.com/dp/B08HNBHSQV?tag=partner-20&th=1";
const shortAffiliate = "https://amzn.to/ExactShortCode";

test("Amazon exact-domain detection rejects lookalikes", () => {
  assert.equal(detectStore("https://amazon.com/dp/B08HNBHSQV"), "amazon");
  assert.equal(detectStore("https://www.amazon.com/dp/B08HNBHSQV"), "amazon");
  assert.equal(detectStore("https://amzn.to/abc"), "amazon");
  assert.equal(detectStore("https://fakeamazon.com/dp/B08HNBHSQV"), undefined);
});

test("ASIN parsing accepts verified PDP path forms and rejects malformed paths", () => {
  assert.equal(amazonAsinFromUrl("https://www.amazon.com/dp/B08HNBHSQV"), "B08HNBHSQV");
  assert.equal(amazonAsinFromUrl("https://www.amazon.com/gp/product/B00MNV8E0C"), "B00MNV8E0C");
  assert.equal(amazonAsinFromUrl("https://www.amazon.com/gp/aw/d/B08HNBHSQV"), undefined);
  assert.equal(amazonAsinFromUrl("https://www.amazon.com/dp/too-short"), undefined);
  assert.equal(amazonAsinFromUrl("https://fakeamazon.com/dp/B08HNBHSQV"), undefined);
});

test("Amazon sale extraction uses one-time deal and genuine higher reference price", () => {
  const { product, asin, priceSource, variantSelection } = extractAmazonProduct(sale, affiliate, saleUrl);
  assert.equal(asin, "B08HNBHSQV");
  assert.equal(product.currentPrice.formatted, "$24.99");
  assert.equal(product.oldPrice.formatted, "$39.99");
  assert.equal(product.imageUrl, "https://m.media-amazon.com/images/I/charger-large.jpg");
  assert.equal(product.postUrl, affiliate);
  assert.equal(priceSource, "json-ld-offer");
  assert.equal(variantSelection, "resolved-url-asin");
});

test("Subscribe & Save, coupon text, installments and unit prices never replace one-time price", () => {
  const saleProduct = extractAmazonProduct(sale, affiliate, saleUrl).product;
  assert.equal(saleProduct.currentPrice.formatted, "$24.99");
  assert.notEqual(saleProduct.currentPrice.formatted, "$19.99");
  assert.notEqual(saleProduct.currentPrice.formatted, "$4.17");
  const regularProduct = extractAmazonProduct(regular, shortAffiliate, regularUrl).product;
  assert.equal(regularProduct.currentPrice.formatted, "$17.99");
  assert.equal(regularProduct.oldPrice, undefined);
  assert.notEqual(regularProduct.currentPrice.formatted, "$15.29");
});

test("Amazon primary buy-box DOM is a valid fallback without structured offer data", () => {
  const withoutJsonLd = sale.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "");
  const extracted = extractAmazonProduct(withoutJsonLd, affiliate, saleUrl);
  assert.equal(extracted.priceSource, "primary-offer-dom");
  assert.equal(extracted.product.currentPrice.formatted, "$24.99");
  assert.equal(extracted.product.oldPrice.formatted, "$39.99");
});

test("Amazon reconstructs a primary visible price when a-price offscreen text is empty", () => {
  const liveShape = sale
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "")
    .replace('<span class="a-offscreen">$24.99</span><span aria-hidden="true"><span class="a-price-whole">24</span><span class="a-price-fraction">99</span></span>', '<span class="a-offscreen"> </span><span aria-hidden="true"><span class="a-price-whole">24<span class="a-price-decimal">.</span></span><span class="a-price-fraction">99</span></span>');
  const extracted = extractAmazonProduct(liveShape, affiliate, saleUrl);
  assert.equal(extracted.priceSource, "primary-offer-dom");
  assert.equal(extracted.product.currentPrice.formatted, "$24.99");
});

test("Amazon reconstructs a split primary price inside a div priceToPay wrapper", () => {
  const liveShape = sale
    .replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "")
    .replace('<span class="a-price priceToPay"><span class="a-offscreen">$24.99</span><span aria-hidden="true"><span class="a-price-whole">24</span><span class="a-price-fraction">99</span></span></span>', '<div class="priceToPay"><span class="a-offscreen"> </span><span aria-hidden="true"><span class="a-price-whole">24<span class="a-price-decimal">.</span></span><span class="a-size-small">separator</span><span class="a-price-fraction">99</span></span></div>');
  const extracted = extractAmazonProduct(liveShape, affiliate, saleUrl);
  assert.equal(extracted.priceSource, "primary-offer-dom");
  assert.equal(extracted.product.currentPrice.formatted, "$24.99");
});

test("Amazon rejects unavailable or non-new structured offers without a primary purchase offer", () => {
  const noPurchase = sale.replace(/<div id="desktop_buybox">[\s\S]*?<\/div>/, "");
  const unavailable = noPurchase
    .replace("https://schema.org/InStock", "https://schema.org/OutOfStock")
    .replace(/<div id="corePrice_feature_div">[\s\S]*?<\/div>/, "");
  assert.throws(() => extractAmazonProduct(unavailable, affiliate, saleUrl), { code: "MISSING_PRICE" });
  const used = unavailable
    .replace("https://schema.org/OutOfStock", "https://schema.org/InStock")
    .replace("https://schema.org/NewCondition", "https://schema.org/UsedCondition");
  assert.throws(() => extractAmazonProduct(used, affiliate, saleUrl), { code: "MISSING_PRICE" });
});

test("old price is omitted unless explicitly represented above current price", () => {
  const lowerReference = sale.replace("$39.99", "$20.00");
  assert.equal(extractAmazonProduct(lowerReference, affiliate, saleUrl).product.oldPrice, undefined);
});

test("Amazon extraction rejects challenge and missing authoritative fields", () => {
  assert.equal(inspectAmazonHtml(challenge, saleUrl).challengeDetected, true);
  assert.equal(usableAmazonHtml(inspectAmazonHtml(challenge, saleUrl)), false);
  assert.throws(() => extractAmazonProduct(challenge, affiliate, saleUrl), { code: "AMAZON_CHALLENGE" });
  assert.throws(() => extractAmazonProduct(sale.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "").replace(/<span class="a-price priceToPay">[\s\S]*?<\/span>\s*<\/span>/, ""), affiliate, saleUrl), { code: "MISSING_PRICE" });
  assert.throws(() => extractAmazonProduct(sale.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "").replace(/<span id="productTitle">[\s\S]*?<\/span>/, "").replace(/<meta property="og:title"[^>]*>/, ""), affiliate, saleUrl), { code: "MISSING_TITLE" });
  assert.throws(() => extractAmazonProduct(sale.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, "").replace(/<img id="landingImage"[^>]*>/, "").replace(/<meta property="og:image"[^>]*>/, ""), affiliate, saleUrl), { code: "MISSING_IMAGE" });
});

test("selected variant mismatch fails rather than borrowing another ASIN state", () => {
  assert.throws(() => extractAmazonProduct(sale.replace(/value="B08HNBHSQV"/, 'value="B00MNV8E0C"'), affiliate, saleUrl), { code: "VARIANT_MISMATCH" });
});

test("JSON-LD for another variation is never borrowed for the resolved ASIN", () => {
  const unrelatedStructuredProduct = sale
    .replace(/"sku":"B08HNBHSQV"/, '"sku":"B00MNV8E0C"')
    .replace(/<span id="productTitle">[\s\S]*?<\/span>/, "")
    .replace(/<meta property="og:title"[^>]*>/, "");
  assert.throws(() => extractAmazonProduct(unrelatedStructuredProduct, affiliate, saleUrl), { code: "MISSING_TITLE" });
});

test("Browser Amazon content loader enforces final Amazon hostname", async () => {
  const browser = { quickAction: async () => Response.json({ success: true, result: sale, meta: { status: 200, finalUrl: saleUrl, redirectChain: [] } }) };
  const loaded = await new BrowserAmazonPageLoader(browser).load(saleUrl, "amazon-loader");
  assert.equal(loaded.resolvedUrl, saleUrl);
  const bad = { quickAction: async () => Response.json({ success: true, result: sale, meta: { status: 200, finalUrl: "https://evil.example.org/product" } }) };
  await assert.rejects(new BrowserAmazonPageLoader(bad).load(saleUrl), { code: "UNSAFE_AMAZON_URL" });
});

test("Amazon card template renders only authoritative values in a distinct fixed card", () => {
  const product = extractAmazonProduct(sale, affiliate, saleUrl).product;
  const html = amazonCardHtml(product, { shortTitle: "ESR Magnetic Car Charger", facebookPost: "unused" }, "data:image/jpeg;base64,/9j/");
  assert.match(html, /Amazon Deal/);
  assert.match(html, /\$24\.99/);
  assert.match(html, /\$39\.99/);
  assert.match(html, /data-card-ready/);
  assert.ok(!html.includes(affiliate));
  assert.ok(!/https?:\/\//.test(html.replace(/http-equiv=/g, "")));
});

test("Amazon cache identity includes ASIN, price, image and Amazon template version without affiliate URL", async () => {
  const a = extractAmazonProduct(sale, affiliate, saleUrl).product;
  const b = { ...a, postUrl: shortAffiliate, inputUrl: shortAffiliate };
  const same = await Promise.all([productStateCacheKey(a, "B08HNBHSQV"), productStateCacheKey(b, "B08HNBHSQV")]);
  assert.equal(same[0].key, same[1].key);
  assert.equal(same[0].r2Prefix.includes("amazon"), true);
  assert.equal(AMAZON_TEMPLATE_VERSION, "amazon-v1");
  assert.notEqual((await productStateCacheKey({ ...a, currentPrice: { ...a.currentPrice, value: 25.99, formatted: "$25.99" } }, "B08HNBHSQV")).key, same[0].key);
  assert.notEqual((await productStateCacheKey(a, "B00MNV8E0C")).key, same[0].key);
  assert.ok(!JSON.stringify(same).includes("partner-20"));
});

test("Amazon cache hit reuses card state but rebuilds copy with this request's exact affiliate URL", async () => {
  let cached;
  let aiCalls = 0;
  let imageFetches = 0;
  let renderCalls = 0;
  const cardCache = {
    lookup: async () => cached
      ? { kind: "hit", shortTitle: cached.shortTitle, card: cached.card, ageSeconds: 1, hitCount: 1 }
      : { kind: "miss", reason: "missing" },
    claim: async () => "builder-token",
    store: async (_identity, _token, shortTitle, card) => { cached = { shortTitle, card }; },
    release: async () => {}
  };
  const copyProvider = { generate: async () => { aiCalls++; return { shortTitle: "ESR Magnetic Car Charger" }; } };
  const renderer = { screenshot: async () => { renderCalls++; return { bytes: new Uint8Array([137,80,78,71,13,10,26,10]), mimeType: "image/png" }; } };
  const firstUrl = affiliate;
  const secondUrl = "https://www.amazon.com/dp/B08HNBHSQV?tag=second-partner-20&th=1&psc=1";
  const makeFetcher = () => async url => {
    if (String(url).includes("m.media-amazon.com")) {
      imageFetches++;
      return new Response(new Uint8Array([255,216,255,217]), { headers: { "content-type": "image/jpeg" } });
    }
    return new Response(sale, { headers: { "content-type": "text/html" } });
  };
  const first = await processProductLink(firstUrl, { fetcher: makeFetcher(), dnsCheck: async () => {}, copyProvider, renderer, cardCache, disclosure: "#Ad", requestId: "amazon-cache-a" });
  const second = await processProductLink(secondUrl, { fetcher: makeFetcher(), dnsCheck: async () => {}, copyProvider, renderer, cardCache, disclosure: "#Ad", requestId: "amazon-cache-b" });
  assert.equal(aiCalls, 1);
  assert.equal(imageFetches, 1);
  assert.equal(renderCalls, 1);
  assert.deepEqual(second.card.bytes, first.card.bytes);
  assert.ok(second.content.facebookPost.endsWith(secondUrl));
  assert.ok(!second.content.facebookPost.includes(firstUrl));
  assert.ok(!JSON.stringify(cached).includes(firstUrl));
  assert.ok(!JSON.stringify(cached).includes(secondUrl));
});

test("Amazon orchestration preserves exact affiliate URL and AI receives title only", async () => {
  const seen = [];
  let renders = 0;
  const image = new Uint8Array([255, 216, 255, 217]);
  const responses = [new Response(sale, { headers: { "content-type": "text/html" } }), new Response(image, { headers: { "content-type": "image/jpeg" } })];
  const result = await processProductLink(affiliate, {
    fetcher: async (url) => { seen.push(url); return responses.shift(); }, dnsCheck: async () => {},
    copyProvider: { generate: async rawTitle => { assert.ok(rawTitle.includes("ESR HaloLock")); assert.ok(!rawTitle.includes(affiliate)); assert.ok(!rawTitle.includes("$24.99")); return { shortTitle: "ESR Magnetic Car Charger" }; } },
    renderer: { screenshot: async html => { renders++; assert.match(html, /Amazon Deal/); return { bytes: new Uint8Array([137,80,78,71,13,10,26,10]), mimeType: "image/png" }; } },
    disclosure: "#Ad", requestId: "amazon-process"
  });
  assert.equal(renders, 1);
  assert.equal(result.product.postUrl, affiliate);
  assert.equal(result.content.facebookPost, `#Ad 🚨 ESR Magnetic Car Charger is now $24.99, was $39.99.\n\n👉 ${affiliate}`);
});

test("amzn.to resolves internally while final copy retains exact short link", async () => {
  const image = new Uint8Array([255,216,255,217]);
  const responses = [new Response(null, { status: 302, headers: { location: saleUrl } }), new Response(sale, { headers: { "content-type": "text/html" } }), new Response(image, { headers: { "content-type": "image/jpeg" } })];
  const result = await processProductLink(shortAffiliate, {
    fetcher: async () => responses.shift(), dnsCheck: async () => {}, copyProvider: { generate: async () => ({ shortTitle: "ESR Magnetic Car Charger" }) },
    renderer: { screenshot: async () => ({ bytes: new Uint8Array([137,80,78,71,13,10,26,10]), mimeType: "image/png" }) }, disclosure: "#Ad", requestId: "amazon-short"
  });
  assert.equal(result.product.resolvedUrl, saleUrl);
  assert.equal(result.product.postUrl, shortAffiliate);
  assert.ok(result.content.facebookPost.endsWith(shortAffiliate));
});

test("unusable Worker HTML uses allowlisted Browser content fallback without screenshot-store path", async () => {
  let loads = 0, cards = 0, pages = 0;
  const image = new Uint8Array([255,216,255,217]);
  const responses = [new Response("<html><title>Amazon</title></html>", { headers: { "content-type": "text/html" } }), new Response(image, { headers: { "content-type": "image/jpeg" } })];
  const result = await processProductLink(affiliate, {
    fetcher: async () => responses.shift(), dnsCheck: async () => {}, copyProvider: { generate: async () => ({ shortTitle: "ESR Magnetic Car Charger" }) },
    renderer: { screenshot: async () => { cards++; return { bytes: new Uint8Array([137,80,78,71,13,10,26,10]), mimeType: "image/png" }; } },
    pageRenderer: { screenshotProductPage: async () => { pages++; throw Error("screenshot store must not run"); } },
    amazonPageLoader: { load: async () => { loads++; return { html: sale, resolvedUrl: saleUrl, httpStatus: 200, responseByteLength: sale.length, redirectCount: 0 }; } },
    disclosure: "#Ad", requestId: "amazon-fallback"
  });
  assert.equal(result.product.store, "amazon");
  assert.equal(loads, 1);
  assert.equal(cards, 1);
  assert.equal(pages, 0);
});
