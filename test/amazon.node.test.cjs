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
const { AmazonCreatorsTokenManager, creatorsTokenEndpoint } = src("stores/amazon/creators-token-manager.js");
const { AmazonCreatorsApiClient, AmazonCreatorsAuthError, amazonCreatorsGetItemsEndpoint, amazonCreatorsRetryBounds } = src("stores/amazon/creators-api-client.js");
const { mapCreatorsItem } = src("stores/amazon/creators-api-product.js");
const { AMAZON_CREATORS_RESOURCES } = src("stores/amazon/creators-api-types.js");
const { processProductLink } = src("orchestration/process-product-link.js");
const { productStateCacheKey, AMAZON_TEMPLATE_VERSION } = src("cache/cache-key.js");
const { buildFacebookPost } = src("ai/build-facebook-post.js");

const sale = readFileSync("test/fixtures/amazon-sale.html", "utf8");
const regular = readFileSync("test/fixtures/amazon-current-only.html", "utf8");
const challenge = readFileSync("test/fixtures/amazon-challenge.html", "utf8");
const saleUrl = "https://www.amazon.com/dp/B08HNBHSQV";
const regularUrl = "https://www.amazon.com/gp/product/B00MNV8E0C";
const affiliate = "https://www.amazon.com/dp/B08HNBHSQV?tag=partner-20&th=1";
const shortAffiliate = "https://amzn.to/ExactShortCode";

test("hosted Creators credential pilot runs directly without Worker or Wrangler operations", () => {
  const workflow = readFileSync(".github/workflows/amazon-creators-pilot.yml", "utf8");
  assert.match(workflow, /amazon-creators-direct-runner\.js/);
  assert.doesNotMatch(workflow, /wrangler|workers\.dev|secret bulk|CLOUDFLARE_|\/ready|workers\/scripts/i);
  assert.doesNotMatch(workflow, /(?:curl|fetch)[^\n]*\/pilot|worker_url|PILOT_RUN_SECRET/i);
  const runner = readFileSync("pilot/amazon-creators-direct-runner.ts", "utf8");
  assert.match(runner, /https:\/\/api\.amazon\.com\/auth\/o2\/token/);
  assert.match(runner, /https:\/\/creatorsapi\.amazon\/catalog\/v1\/getItems/);
  assert.match(runner, /creatorsapi::default/);
  assert.doesNotMatch(runner, /console\.(?:log|error)\([^\n]*(?:accessToken|clientId|clientSecret|authorization)\b/);
});

function creatorsListing(overrides = {}) {
  return {
    availability: { type: "IN_STOCK", message: "In Stock" },
    condition: { value: "New", subCondition: "Unknown" },
    isBuyBoxWinner: true,
    merchantInfo: { id: "ATVPDKIKX0DER", name: "Amazon.com" },
    price: { money: { amount: 24.99, currency: "USD", displayAmount: "$24.99" } },
    ...overrides
  };
}

function creatorsItem(overrides = {}) {
  return {
    asin: "B08HNBHSQV",
    detailPageURL: "https://www.amazon.com/dp/B08HNBHSQV?tag=api-20",
    itemInfo: { title: { displayValue: "ESR HaloLock Magnetic Wireless Car Charger" } },
    images: { primary: { large: { url: "https://m.media-amazon.com/images/I/charger-large.jpg", width: 1000, height: 1000 } } },
    offersV2: { listings: [creatorsListing()] },
    ...overrides
  };
}

function creatorsProvider(item = creatorsItem()) {
  return { product: async (asin, inputUrl, resolvedUrl) => mapCreatorsItem(item, asin, inputUrl, resolvedUrl) };
}

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

test("Creators token is obtained, cached, refreshed near expiry, and uses the official version endpoint", async () => {
  let now = 1_000;
  let calls = 0;
  const manager = new AmazonCreatorsTokenManager(
    { clientId: "credential-id", clientSecret: "credential-secret", credentialVersion: "3.1" },
    async (url, init) => {
      calls++;
      assert.equal(url, creatorsTokenEndpoint("3.1"));
      const body = JSON.parse(init.body);
      assert.deepEqual(body, { grant_type: "client_credentials", client_id: "credential-id", client_secret: "credential-secret", scope: "creatorsapi::default" });
      return Response.json({ access_token: `token-${calls}`, token_type: "bearer", expires_in: 3600 });
    },
    () => now
  );
  assert.equal(await manager.getToken("token-test"), "token-1");
  assert.equal(await manager.getToken("token-test"), "token-1");
  assert.equal(calls, 1);
  now += 3_541_000;
  assert.equal(await manager.getToken("token-test"), "token-2");
  assert.equal(calls, 2);
});

test("Creators token refresh is single-flighted within one isolate", async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const manager = new AmazonCreatorsTokenManager(
    { clientId: "id", clientSecret: "secret", credentialVersion: "3.1" },
    async () => { calls++; await gate; return Response.json({ access_token: "shared", expires_in: 3600 }); }
  );
  const pending = [manager.getToken(), manager.getToken(), manager.getToken()];
  await Promise.resolve();
  assert.equal(calls, 1);
  release();
  assert.deepEqual(await Promise.all(pending), ["shared", "shared", "shared"]);
});

test("Creators token authentication failure is classified safely", async () => {
  const manager = new AmazonCreatorsTokenManager(
    { clientId: "id", clientSecret: "secret", credentialVersion: "3.1" },
    async () => Response.json({ error: "invalid_client" }, { status: 401 })
  );
  await assert.rejects(manager.getToken(), { code: "AMAZON_CREATORS_AUTH_FAILED" });
});

test("Creators GetItems uses official endpoint, resources, marketplace and one bounded 429 retry", async () => {
  let calls = 0;
  const waits = [];
  const tokenManager = { getToken: async () => "access-token" };
  const client = new AmazonCreatorsApiClient(tokenManager, { marketplace: "www.amazon.com", partnerTag: "partner-20" }, async (url, init) => {
    calls++;
    assert.equal(url, amazonCreatorsGetItemsEndpoint);
    assert.equal(init.headers.authorization, "Bearer access-token");
    assert.equal(init.headers["x-marketplace"], "www.amazon.com");
    const body = JSON.parse(init.body);
    assert.deepEqual(body.itemIds, ["B08HNBHSQV"]);
    assert.equal(body.condition, "New");
    assert.deepEqual(body.resources, AMAZON_CREATORS_RESOURCES);
    if (calls === 1) return Response.json({ type: "ThrottleException", retryAfterSeconds: 2 }, { status: 429 });
    return Response.json({ itemResults: { items: [creatorsItem()] } });
  }, async milliseconds => { waits.push(milliseconds); });
  assert.equal((await client.getItem("B08HNBHSQV")).asin, "B08HNBHSQV");
  assert.equal(calls, 2);
  assert.deepEqual(waits, [2000]);
  assert.deepEqual(amazonCreatorsRetryBounds, { minMs: 250, fallbackMs: 1000, maxMs: 5000 });
});

test("Creators GetItems stops after two throttled attempts", async () => {
  let calls = 0;
  const client = new AmazonCreatorsApiClient({ getToken: async () => "token" }, { marketplace: "www.amazon.com", partnerTag: "tag-20" }, async () => {
    calls++;
    return Response.json({ type: "ThrottleException" }, { status: 429 });
  }, async () => {});
  await assert.rejects(client.getItem("B08HNBHSQV"), { code: "AMAZON_CREATORS_RATE_LIMITED" });
  assert.equal(calls, 2);
});

test("Creators GetItems classifies API authorization failure", async () => {
  const client = new AmazonCreatorsApiClient({ getToken: async () => "token" }, { marketplace: "www.amazon.com", partnerTag: "tag-20" }, async () => Response.json({ type: "UnauthorizedException" }, { status: 401 }));
  await assert.rejects(client.getItem("B08HNBHSQV"), { code: "AMAZON_CREATORS_AUTH_FAILED" });
});

test("Creators GetItems retains only safe structured Amazon 403 diagnostics", async () => {
  const logged = [];
  const originalError = console.error;
  console.error = value => logged.push(String(value));
  try {
    const client = new AmazonCreatorsApiClient(
      { getToken: async () => "access-token-must-not-be-logged" },
      { marketplace: "www.amazon.com", partnerTag: "tag-20" },
      async () => Response.json({ errors: [{ type: "ForbiddenException", code: "AssociateNotEligible", message: "sensitive diagnostic text" }] }, { status: 403 })
    );
    await assert.rejects(client.getItem("B08HNBHSQV", "safe-request"), error => {
      assert.equal(error instanceof AmazonCreatorsAuthError, true);
      assert.equal(error.code, "AMAZON_CREATORS_AUTH_FAILED");
      assert.deepEqual(error.amazonDiagnostics, {
        httpStatus: 403,
        amazonApiErrorType: "ForbiddenException",
        amazonApiErrorCode: "AssociateNotEligible"
      });
      return true;
    });
  } finally {
    console.error = originalError;
  }
  const output = logged.join("\n");
  assert.match(output, /"requestId":"safe-request"/);
  assert.match(output, /"asin":"B08HNBHSQV"/);
  assert.match(output, /"httpStatus":403/);
  assert.match(output, /"amazonApiErrorType":"ForbiddenException"/);
  assert.match(output, /"amazonApiErrorCode":"AssociateNotEligible"/);
  assert.doesNotMatch(output, /sensitive diagnostic text|access-token-must-not-be-logged|tag-20/);
});

test("Creators GetItems classifies an inaccessible item and exact-ASIN mismatch", async () => {
  const inaccessible = new AmazonCreatorsApiClient({ getToken: async () => "token" }, { marketplace: "www.amazon.com", partnerTag: "tag-20" }, async () => Response.json({ errors: [{ code: "ItemNotAccessible" }] }));
  await assert.rejects(inaccessible.getItem("B08HNBHSQV"), { code: "AMAZON_ITEM_NOT_FOUND" });
  const mismatch = new AmazonCreatorsApiClient({ getToken: async () => "token" }, { marketplace: "www.amazon.com", partnerTag: "tag-20" }, async () => Response.json({ itemResults: { items: [creatorsItem({ asin: "B00MNV8E0C" })] } }));
  await assert.rejects(mismatch.getItem("B08HNBHSQV"), { code: "AMAZON_ASIN_MISMATCH" });
});

test("Creators product maps current price with no reference", () => {
  const product = mapCreatorsItem(creatorsItem(), "B08HNBHSQV", affiliate, saleUrl);
  assert.equal(product.currentPrice.formatted, "$24.99");
  assert.equal(product.oldPrice, undefined);
  assert.equal(product.rawTitle, "ESR HaloLock Magnetic Wireless Car Charger");
  assert.equal(product.postUrl, affiliate);
});

test("Creators product maps WAS_PRICE and LIST_PRICE with deterministic wording", () => {
  for (const [apiType, expectedType, phrase] of [["WAS_PRICE", "WAS_PRICE", "was"], ["LIST_PRICE", "LIST_PRICE", "list price"]]) {
    const item = creatorsItem({ offersV2: { listings: [creatorsListing({ price: {
      money: { amount: 24.99, currency: "USD", displayAmount: "$24.99" },
      savingBasis: { money: { amount: 39.99, currency: "USD", displayAmount: "$39.99" }, savingBasisType: apiType },
      savings: { money: { amount: 15, currency: "USD", displayAmount: "$15.00" }, percentage: 38 }
    } })] } });
    const product = mapCreatorsItem(item, "B08HNBHSQV", affiliate, saleUrl);
    assert.equal(product.oldPrice.formatted, "$39.99");
    assert.equal(product.amazon.referencePriceType, expectedType);
    assert.equal(product.amazon.savings.percentage, 38);
    assert.equal(buildFacebookPost(product, "ESR Magnetic Car Charger", "#Ad"), `#Ad 🚨 ESR Magnetic Car Charger is now $24.99, ${phrase} $39.99.\n\n👉 ${affiliate}`);
  }
});

test("Creators reference price is omitted when not higher, currency differs, or semantics are unsupported", () => {
  for (const basis of [
    { money: { amount: 20, currency: "USD", displayAmount: "$20.00" }, savingBasisType: "WAS_PRICE" },
    { money: { amount: 39.99, currency: "CAD", displayAmount: "CA$39.99" }, savingBasisType: "WAS_PRICE" },
    { money: { amount: 39.99, currency: "USD", displayAmount: "$39.99" }, savingBasisType: "LOWEST_PRICE" }
  ]) {
    const product = mapCreatorsItem(creatorsItem({ offersV2: { listings: [creatorsListing({ price: { money: { amount: 24.99, currency: "USD", displayAmount: "$24.99" }, savingBasis: basis } })] } }), "B08HNBHSQV", affiliate, saleUrl);
    assert.equal(product.oldPrice, undefined);
    assert.equal(product.amazon.referencePriceType, undefined);
  }
});

test("Creators offer selection excludes Subscribe & Save and selects normal featured offer", () => {
  const subscription = creatorsListing({ type: "SUBSCRIBE_AND_SAVE", price: { money: { amount: 19.99, currency: "USD", displayAmount: "$19.99" } } });
  const normal = creatorsListing({ price: { money: { amount: 24.99, currency: "USD", displayAmount: "$24.99" } } });
  const product = mapCreatorsItem(creatorsItem({ offersV2: { listings: [subscription, normal] } }), "B08HNBHSQV", affiliate, saleUrl);
  assert.equal(product.currentPrice.formatted, "$24.99");
  assert.throws(() => mapCreatorsItem(creatorsItem({ offersV2: { listings: [subscription] } }), "B08HNBHSQV", affiliate, saleUrl), { code: "AMAZON_NO_PURCHASABLE_OFFER" });
});

test("Creators offer selection rejects unavailable, unsupported condition, MAP, and unrelated non-Buy-Box offers", () => {
  const invalid = [
    creatorsListing({ availability: { type: "OUT_OF_STOCK" } }),
    creatorsListing({ condition: { value: "Used" } }),
    creatorsListing({ condition: { value: "Refurbished" } }),
    creatorsListing({ condition: { value: "Renewed" } }),
    creatorsListing({ condition: { value: "Unknown", subCondition: "Refurbished" } }),
    creatorsListing({ violatesMAP: true }),
    creatorsListing({ isBuyBoxWinner: false })
  ];
  for (const listing of invalid) assert.throws(() => mapCreatorsItem(creatorsItem({ offersV2: { listings: [listing] } }), "B08HNBHSQV", affiliate, saleUrl), { code: "AMAZON_NO_PURCHASABLE_OFFER" });
});

test("Creators offer selection prefers the explicit Buy Box winner", () => {
  const other = creatorsListing({ isBuyBoxWinner: false, price: { money: { amount: 20, currency: "USD", displayAmount: "$20.00" } } });
  const winner = creatorsListing({ isBuyBoxWinner: true, price: { money: { amount: 24.99, currency: "USD", displayAmount: "$24.99" } } });
  assert.equal(mapCreatorsItem(creatorsItem({ offersV2: { listings: [other, winner] } }), "B08HNBHSQV", affiliate, saleUrl).currentPrice.formatted, "$24.99");
});

test("Creators deal details are retained while restricted deals are rejected", () => {
  const publicDeal = creatorsListing({ type: "LIGHTNING_DEAL", dealDetails: { accessType: "ALL", badge: "Limited time deal", startTime: "2026-01-01T00:00:00Z", endTime: "2026-01-02T00:00:00Z" } });
  const product = mapCreatorsItem(creatorsItem({ offersV2: { listings: [publicDeal] } }), "B08HNBHSQV", affiliate, saleUrl);
  assert.equal(product.amazon.dealDetails.badge, "Limited time deal");
  const restricted = creatorsListing({ dealDetails: { accessType: "PRIME_EXCLUSIVE" } });
  assert.throws(() => mapCreatorsItem(creatorsItem({ offersV2: { listings: [restricted] } }), "B08HNBHSQV", affiliate, saleUrl), { code: "AMAZON_NO_PURCHASABLE_OFFER" });
});

test("Creators product rejects missing price, title, image, ASIN mismatch, and non-purchasable parent", () => {
  assert.throws(() => mapCreatorsItem(creatorsItem({ offersV2: { listings: [creatorsListing({ price: undefined })] } }), "B08HNBHSQV", affiliate, saleUrl), { code: "AMAZON_NO_PURCHASABLE_OFFER" });
  assert.throws(() => mapCreatorsItem(creatorsItem({ itemInfo: {} }), "B08HNBHSQV", affiliate, saleUrl), { code: "MISSING_TITLE" });
  assert.throws(() => mapCreatorsItem(creatorsItem({ images: {} }), "B08HNBHSQV", affiliate, saleUrl), { code: "MISSING_IMAGE" });
  assert.throws(() => mapCreatorsItem(creatorsItem({ asin: "B00MNV8E0C" }), "B08HNBHSQV", affiliate, saleUrl), { code: "AMAZON_ASIN_MISMATCH" });
  assert.throws(() => mapCreatorsItem(creatorsItem({ parentASIN: "B08HNBHSQV", offersV2: { listings: [] } }), "B08HNBHSQV", affiliate, saleUrl), { code: "AMAZON_NO_PURCHASABLE_OFFER" });
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

test("Amazon Creators orchestration preserves exact affiliate URL, isolates AI, and disables card cache", async () => {
  const seen = [];
  let renders = 0;
  let cacheCalls = 0;
  const image = new Uint8Array([255, 216, 255, 217]);
  const responses = [new Response("resolution only", { headers: { "content-type": "text/html" } }), new Response(image, { headers: { "content-type": "image/jpeg" } })];
  const result = await processProductLink(affiliate, {
    fetcher: async (url) => { seen.push(url); return responses.shift(); }, dnsCheck: async () => {},
    copyProvider: { generate: async rawTitle => { assert.equal(rawTitle, "ESR HaloLock Magnetic Wireless Car Charger"); assert.ok(!rawTitle.includes(affiliate)); assert.ok(!rawTitle.includes("$24.99")); assert.ok(!rawTitle.includes("B08HNBHSQV")); return { shortTitle: "ESR Magnetic Car Charger" }; } },
    renderer: { screenshot: async html => { renders++; assert.match(html, /Amazon Deal/); return { bytes: new Uint8Array([137,80,78,71,13,10,26,10]), mimeType: "image/png" }; } },
    amazonProductProvider: creatorsProvider(creatorsItem({ offersV2: { listings: [creatorsListing({ price: {
      money: { amount: 24.99, currency: "USD", displayAmount: "$24.99" },
      savingBasis: { money: { amount: 39.99, currency: "USD", displayAmount: "$39.99" }, savingBasisType: "WAS_PRICE" }
    } })] } })),
    cardCache: { lookup: async () => { cacheCalls++; throw Error("must not read"); }, claim: async () => { cacheCalls++; return null; }, store: async () => { cacheCalls++; }, release: async () => { cacheCalls++; } },
    disclosure: "#Ad", requestId: "amazon-process"
  });
  assert.equal(renders, 1);
  assert.equal(cacheCalls, 0);
  assert.equal(result.product.postUrl, affiliate);
  assert.equal(result.content.facebookPost, `#Ad 🚨 ESR Magnetic Car Charger is now $24.99, was $39.99.\n\n👉 ${affiliate}`);
});

test("amzn.to resolves internally while final copy retains exact short link", async () => {
  const image = new Uint8Array([255,216,255,217]);
  const responses = [new Response(null, { status: 302, headers: { location: saleUrl } }), new Response("resolution only", { headers: { "content-type": "text/html" } }), new Response(image, { headers: { "content-type": "image/jpeg" } })];
  const result = await processProductLink(shortAffiliate, {
    fetcher: async () => responses.shift(), dnsCheck: async () => {}, copyProvider: { generate: async () => ({ shortTitle: "ESR Magnetic Car Charger" }) },
    renderer: { screenshot: async () => ({ bytes: new Uint8Array([137,80,78,71,13,10,26,10]), mimeType: "image/png" }) }, disclosure: "#Ad", requestId: "amazon-short"
    , amazonProductProvider: creatorsProvider()
  });
  assert.equal(result.product.resolvedUrl, saleUrl);
  assert.equal(result.product.postUrl, shortAffiliate);
  assert.ok(result.content.facebookPost.endsWith(shortAffiliate));
});

test("Amazon Creators path never invokes HTML extraction, Browser content fallback, or screenshot-store rendering", async () => {
  let cards = 0, pages = 0;
  const image = new Uint8Array([255,216,255,217]);
  const responses = [new Response("<html><title>intentionally unusable</title></html>", { headers: { "content-type": "text/html" } }), new Response(image, { headers: { "content-type": "image/jpeg" } })];
  const result = await processProductLink(affiliate, {
    fetcher: async () => responses.shift(), dnsCheck: async () => {}, copyProvider: { generate: async () => ({ shortTitle: "ESR Magnetic Car Charger" }) },
    renderer: { screenshot: async () => { cards++; return { bytes: new Uint8Array([137,80,78,71,13,10,26,10]), mimeType: "image/png" }; } },
    pageRenderer: { screenshotProductPage: async () => { pages++; throw Error("screenshot store must not run"); } },
    amazonProductProvider: creatorsProvider(),
    disclosure: "#Ad", requestId: "amazon-fallback"
  });
  assert.equal(result.product.store, "amazon");
  assert.equal(cards, 1);
  assert.equal(pages, 0);
});
