const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const root = process.env.COMPILED_ROOT;
const req = relative => require(path.join(root, relative));

const { ProductError } = req("types.js");
const { SovrnClient } = req("stores/sovrn/client.js");
const { buildSovrnPlainlink } = req("stores/sovrn/plainlink.js");
const { classifySovrnVariant, inspectSovrnSource } = req("stores/sovrn/source-identity.js");
const { PriceComparisonSovrnProductProvider } = req("stores/sovrn/product-provider.js");
const { merchantMatchesStore, sovrnStoreForHostname } = req("stores/sovrn/merchant-registry.js");
const { decodeSovrnOffers } = req("stores/sovrn/wire.js");
const { enrichWalmartWithSovrn, moneyCents, walmartSovrnReferenceParity } = req("stores/sovrn/walmart-integration.js");
const { buildFacebookComment, buildFacebookPost } = req("ai/build-facebook-post.js");
const { processProductLink } = req("orchestration/process-product-link.js");

const config = { secretKey: "secret-value", siteApiKey: "site-value", market: "usd_en" };
const image = "https://i5.walmartimages.com/product.jpeg";
const sourceUrl = "https://www.walmart.com/ip/Ninja-Coffee-Machine-PB045/13162221820?affid=original";
const resolvedUrl = "https://www.walmart.com/ip/Ninja-Coffee-Machine-PB045/13162221820";
const title = "Ninja Pods & Grounds Hot & Iced Single-Serve Coffee Maker K-Cup Pod Compatible Rapid Cold Brew PB045 Black";
const sourceHtml = ({ model = "PB045", color = "Black", name = title, canonical = resolvedUrl } = {}) =>
  `<link rel="canonical" href="${canonical}"><script type="application/ld+json">${JSON.stringify({ "@type": "Product", name, model, color })}</script>`;
const offer = (overrides = {}) => ({
  merchant: { name: "Walmart", id: 384 }, name: title, id: 11693243338,
  salePrice: 79.99, retailPrice: 89, currency: "USD", affiliatable: true,
  image, thumbnail: image, deeplink: "https://credential-bearing.example/never-use", ...overrides
});

function providerFor(value, options = {}) {
  let calls = 0;
  const client = new SovrnClient(config, async () => {
    calls++;
    if (options.status) return new Response("safe failure", { status: options.status });
    return Response.json(value);
  }, async () => {});
  return { provider: new PriceComparisonSovrnProductProvider(client), calls: () => calls };
}
const input = (overrides = {}) => ({ store: "walmart", sourceProduct: sourceProduct(), postUrl: sourceUrl, resolvedUrl, sourceHtml: sourceHtml(), requestId: "test", ...overrides });
async function rejectCode(promise, code) {
  await assert.rejects(promise, error => error instanceof ProductError && error.code === code);
}

const sourceProduct = (overrides = {}) => ({
  store: "walmart", inputUrl: sourceUrl, postUrl: sourceUrl, resolvedUrl,
  canonicalProductUrl: resolvedUrl, rawTitle: title, imageUrl: "https://i5.walmartimages.com/source.jpeg",
  currentPrice: { value: 79.99, currency: "USD", formatted: "$79.99" },
  oldPrice: { value: 89, currency: "USD", formatted: "$89.00" },
  ...overrides
});
const candidateResult = (overrides = {}) => ({
  product: sourceProduct({ imageUrl: image, ...overrides }),
  identity: { productMatchConfirmed: true, variantClassification: "EXACT_VARIANT_MATCH", sourceVariant: { explicit: true }, offerVariant: { explicit: true } },
  merchantId: 384
});
const integrationProvider = (result) => ({ product: async () => result });
const integrate = (source, result, overrides = {}) => enrichWalmartWithSovrn({
  sourceProduct: source,
  sourceHtml: sourceHtml(),
  requestId: "integration-test",
  provider: integrationProvider(result),
  validateImage: async () => {},
  ...overrides
});

test("Walmart production and Home Depot feasibility adapters are registered while other retailers remain disabled", () => {
  assert.equal(sovrnStoreForHostname("www.walmart.com"), "walmart");
  assert.equal(sovrnStoreForHostname("www.homedepot.com"), "homedepot");
  for (const hostname of ["amazon.com", "elfcosmetics.com", "target.com", "ulta.com", "sephora.com"]) assert.equal(sovrnStoreForHostname(hostname), undefined);
});

test("Walmart plainlink strips tracking while preserving item identity and input", () => {
  const original = `${resolvedUrl}?selectedSellerId=0&utm_source=pilot&affid=abc`;
  const result = buildSovrnPlainlink(original, "walmart");
  assert.equal(original, `${resolvedUrl}?selectedSellerId=0&utm_source=pilot&affid=abc`);
  assert.equal(result.plainlink, `${resolvedUrl}?selectedSellerId=0`);
  assert.equal(result.productIdentity, "13162221820");
});

test("same-retailer Walmart offer is accepted and cheaper alternate merchant is ignored", async () => {
  const result = await providerFor([offer({ merchant: { name: "Other", id: 1 }, salePrice: 1 }), offer()]).provider.product(input());
  assert.equal(result.product.currentPrice.value, 79.99);
  assert.equal(result.merchantId, 384);
});

test("empty 200 and offers without Walmart have distinct safe outcomes", async () => {
  await rejectCode(providerFor([]).provider.product(input()), "SOVRN_NO_OFFER_FOR_PLAINLINK");
  await rejectCode(providerFor([offer({ merchant: { name: "Other", id: 1 } })]).provider.product(input()), "SOVRN_NO_SAME_RETAILER_OFFER");
});

test("opaque Sovrn result id never conflicts with Walmart item id", async () => {
  const result = await providerFor([offer({ id: 11693243338 })]).provider.product(input());
  assert.equal(result.identity.variantClassification, "EXACT_VARIANT_MATCH");
  assert.equal(decodeSovrnOffers([offer()])[0].offerId, 11693243338);
  assert.equal(decodeSovrnOffers([offer()])[0].identity.productId, undefined);
});

test("matching Walmart model and color are an exact variant match", async () => {
  const result = await providerFor([offer()]).provider.product(input());
  assert.equal(result.identity.productMatchConfirmed, true);
  assert.equal(result.identity.variantClassification, "EXACT_VARIANT_MATCH");
  assert.equal(result.identity.sourceVariant.mpn, "PB045");
  assert.equal(result.identity.offerVariant.mpn, "PB045");
});

test("same product without shared strong identifiers remains NO_VARIANT_CONFLICT", async () => {
  const html = sourceHtml({ model: null, color: null });
  const result = await providerFor([offer({ name: title.replace(/ PB045 Black$/, "") })]).provider.product(input({ sourceHtml: html }));
  assert.equal(result.identity.variantClassification, "NO_VARIANT_CONFLICT");
});

test("explicit Walmart color and model conflicts are rejected", async () => {
  await rejectCode(providerFor([offer({ name: title.replace(/Black$/, "White") })]).provider.product(input()), "SOVRN_VARIANT_CONFLICT");
  await rejectCode(providerFor([offer({ mpn: "PB051" })]).provider.product(input()), "SOVRN_VARIANT_CONFLICT");
});

test("Expert Grill reordered title words are accepted only with exact structured 24-inch Black evidence", async () => {
  const expertUrl = "https://www.walmart.com/ip/Expert-Grill-Heavy-Duty-24-inch-Charcoal-Grill-Black/746021606";
  const expertTitle = "Expert Grill Heavy Duty Charcoal Grill 24 Inch Black Steel";
  const expertHtml = `<link rel="canonical" href="${expertUrl}"><script type="application/ld+json">${JSON.stringify({
    "@type": "Product", name: expertTitle, model: "XG1910200103", size: "24 Inch", color: "Black"
  })}</script>`;
  const expertSource = sourceProduct({
    inputUrl: expertUrl, postUrl: expertUrl, resolvedUrl: expertUrl, canonicalProductUrl: expertUrl,
    rawTitle: expertTitle,
    currentPrice: { value: 98, currency: "USD", formatted: "$98.00" },
    oldPrice: { value: 124, currency: "USD", formatted: "$124.00" }
  });
  const expertOffer = offer({
    name: "Expert Grill Charcoal Grill, 24 Inch Heavy Duty Charcoal Grill with Wheels, Black",
    salePrice: 124, retailPrice: 0, mpn: undefined
  });
  const fixture = providerFor([expertOffer]);
  const candidate = await fixture.provider.product(input({
    sourceProduct: expertSource, postUrl: expertUrl, resolvedUrl: expertUrl, sourceHtml: expertHtml
  }));
  assert.equal(candidate.identity.productMatchConfirmed, true);
  assert.equal(candidate.identity.variantClassification, "EXACT_VARIANT_MATCH");
  assert.equal(candidate.identity.sourceVariant.size, "24 Inch");
  assert.equal(candidate.identity.offerVariant.size, "24 Inch");

  const result = await enrichWalmartWithSovrn({
    sourceProduct: expertSource,
    sourceHtml: expertHtml,
    provider: integrationProvider(candidate),
    validateImage: async () => {}
  });
  assert.equal(result.telemetry.sovrnStatus, "PRICE_MISMATCH");
  assert.equal(result.telemetry.priceParity, "DIFFERENT");
  assert.equal(result.telemetry.walmartCurrentCents, 9800);
  assert.equal(result.telemetry.sovrnCurrentCents, 12400);
  assert.equal(result.telemetry.deltaCents, 2600);
  assert.equal(result.telemetry.finalSource, "WALMART_FALLBACK");
  assert.equal(result.product, expertSource);
});

test("Expert Grill structured model, size, and color conflicts remain rejected", async () => {
  const expertUrl = "https://www.walmart.com/ip/Expert-Grill/746021606";
  const expertTitle = "Expert Grill Heavy Duty Charcoal Grill 24 Inch Black Steel";
  const expertSource = sourceProduct({ resolvedUrl: expertUrl, canonicalProductUrl: expertUrl, rawTitle: expertTitle });
  const baseHtml = { "@type": "Product", name: expertTitle, model: "XG1910200103", size: "24 Inch", color: "Black" };
  const call = (htmlPatch, offerPatch) => providerFor([offer({
    name: "Expert Grill Charcoal Grill, 24 Inch Heavy Duty Charcoal Grill with Wheels, Black",
    salePrice: 124, retailPrice: 0, ...offerPatch
  })]).provider.product(input({
    sourceProduct: expertSource, postUrl: expertUrl, resolvedUrl: expertUrl,
    sourceHtml: `<link rel="canonical" href="${expertUrl}"><script type="application/ld+json">${JSON.stringify({ ...baseHtml, ...htmlPatch })}</script>`
  }));
  await rejectCode(call({}, { mpn: "XG-DIFFERENT" }), "SOVRN_VARIANT_CONFLICT");
  await rejectCode(call({}, { name: "Expert Grill Charcoal Grill, 32 Inch Heavy Duty Charcoal Grill with Wheels, Black" }), "SOVRN_VARIANT_CONFLICT");
  await rejectCode(call({}, { name: "Expert Grill Charcoal Grill, 24 Inch Heavy Duty Charcoal Grill with Wheels, White" }), "SOVRN_VARIANT_CONFLICT");
});

test("PB045, Ozark, and BlendBOSS identity acceptance remains unchanged", async () => {
  const cases = [
    {
      url: resolvedUrl, sourceTitle: title, model: "PB045", color: "Black",
      offerTitle: title, salePrice: 79.99, retailPrice: 89
    },
    {
      url: "https://www.walmart.com/ip/Ozark-Trail-Grill/19658170815",
      sourceTitle: "Ozark Trail Disposable Instant Charcoal Grill, 1 lb. Charcoal Content",
      model: "32500LIS", size: "1 lb",
      offerTitle: "Ozark Trail Disposable Instant Charcoal Grill 1 lb. Charcoal Content",
      salePrice: 9.88, retailPrice: 9.88
    },
    {
      url: "https://www.walmart.com/ip/Ninja-BlendBOSS/18317156543",
      sourceTitle: "Ninja BlendBOSS 26-Oz Personal Blender for Smoothies & Frozen Drinks Travel Tumbler Auto-iQ 1200PW DB351CY Cyberspace",
      model: "DB351CY", size: "26 oz", color: "Cyberspace",
      offerTitle: "Ninja BlendBOSS 26-Oz Personal Blender for Smoothies & Frozen Drinks Travel Tumbler Auto-iQ Technology 1200PW DB351CY Cyberspace",
      salePrice: 129.97, retailPrice: 129.99
    }
  ];
  for (const item of cases) {
    const source = sourceProduct({
      inputUrl: item.url, postUrl: item.url, resolvedUrl: item.url, canonicalProductUrl: item.url,
      rawTitle: item.sourceTitle
    });
    const html = `<link rel="canonical" href="${item.url}"><script type="application/ld+json">${JSON.stringify({
      "@type": "Product", name: item.sourceTitle, model: item.model, size: item.size, color: item.color
    })}</script>`;
    const result = await providerFor([offer({ name: item.offerTitle, salePrice: item.salePrice, retailPrice: item.retailPrice })])
      .provider.product(input({ sourceProduct: source, postUrl: item.url, resolvedUrl: item.url, sourceHtml: html }));
    assert.equal(result.identity.productMatchConfirmed, true);
    assert.ok(["EXACT_VARIANT_MATCH", "NO_VARIANT_CONFLICT"].includes(result.identity.variantClassification));
  }
});

test("high-risk family ambiguity remains rejected", () => {
  assert.equal(classifySovrnVariant({ explicit: false, multiVariantFamily: true }, { explicit: true, size: "8 oz" }), "VARIANT_AMBIGUOUS_HIGH_RISK");
});

test("missing current-request Walmart source identity fails closed", async () => {
  const fixture = providerFor([offer()]);
  await rejectCode(fixture.provider.product(input({ sourceProduct: sourceProduct({ resolvedUrl: "https://www.walmart.com/search?q=unavailable", canonicalProductUrl: undefined }), sourceHtml: "<html><title>Unavailable</title></html>" })), "SOVRN_SOURCE_IDENTITY_UNAVAILABLE");
  assert.equal(fixture.calls(), 1);
});

test("positive USD salePrice and higher retailPrice map deterministically", async () => {
  const product = (await providerFor([offer()]).provider.product(input())).product;
  assert.deepEqual(product.currentPrice, { value: 79.99, currency: "USD", formatted: "$79.99" });
  assert.deepEqual(product.oldPrice, { value: 89, currency: "USD", formatted: "$89.00" });
});

test("zero, negative, malformed salePrice and non-USD currency are rejected", async () => {
  for (const patch of [{ salePrice: 0 }, { salePrice: -1 }, { salePrice: "79.99" }, { currency: "CAD" }, { currency: undefined }]) {
    await rejectCode(providerFor([offer(patch)]).provider.product(input()), "SOVRN_INVALID_PRICE");
  }
});

test("equal, zero, lower, or malformed retailPrice is omitted", async () => {
  for (const retailPrice of [79.99, 0, 70, "89", undefined]) {
    const product = (await providerFor([offer({ retailPrice })]).provider.product(input())).product;
    assert.equal(product.oldPrice, undefined);
  }
});

test("HTTPS product image is accepted and invalid image URLs are rejected", async () => {
  assert.equal((await providerFor([offer()]).provider.product(input())).product.imageUrl, image);
  for (const value of [undefined, "not-a-url", "http://i5.walmartimages.com/product.jpeg"]) {
    await rejectCode(providerFor([offer({ image: value })]).provider.product(input()), "SOVRN_INVALID_IMAGE");
  }
});

test("PB045 exact-cent parity makes Sovrn title and image eligible while Walmart prices remain authoritative", async () => {
  const source = sourceProduct();
  const result = await integrate(source, candidateResult());
  assert.equal(result.telemetry.sovrnStatus, "ACCEPTED");
  assert.equal(result.telemetry.priceParity, "EXACT");
  assert.equal(result.telemetry.referenceParity, "EXACT");
  assert.equal(result.product.rawTitle, title);
  assert.equal(result.product.imageUrl, image);
  assert.equal(result.product.currentPrice, source.currentPrice);
  assert.equal(result.product.oldPrice, source.oldPrice);
});

test("Ozark and BlendBOSS exact current-price parity are eligible without exposing Sovrn-only reference prices", async () => {
  const cases = [
    { name: "Ozark Trail Disposable Instant Charcoal Grill", value: 9.88, formatted: "$9.88", sovrnOldPrice: undefined },
    { name: "Ninja BlendBOSS DB351CY Cyberspace 26 oz", value: 129.97, formatted: "$129.97", sovrnOldPrice: { value: 129.99, currency: "USD", formatted: "$129.99" } }
  ];
  for (const item of cases) {
    const source = sourceProduct({ rawTitle: item.name, currentPrice: { value: item.value, currency: "USD", formatted: item.formatted }, oldPrice: undefined });
    const candidate = candidateResult({ rawTitle: item.name, currentPrice: { value: item.value, currency: "USD", formatted: item.formatted }, oldPrice: item.sovrnOldPrice });
    const result = await integrate(source, candidate);
    assert.equal(result.telemetry.sovrnStatus, "ACCEPTED");
    assert.equal(result.telemetry.priceParity, "EXACT");
    assert.equal(result.telemetry.referenceParity, item.sovrnOldPrice ? "SOVRN_ONLY" : "NEITHER");
    assert.equal(result.product.oldPrice, undefined);
  }
});

test("Expert Grill stale Sovrn current price is rejected even for the same product and variant", async () => {
  const source = sourceProduct({
    rawTitle: "Expert Grill Heavy Duty 24 inch Charcoal Grill Black",
    currentPrice: { value: 98, currency: "USD", formatted: "$98.00" },
    oldPrice: { value: 124, currency: "USD", formatted: "$124.00" }
  });
  const candidate = candidateResult({
    rawTitle: source.rawTitle,
    currentPrice: { value: 124, currency: "USD", formatted: "$124.00" },
    oldPrice: undefined
  });
  const result = await integrate(source, candidate);
  assert.equal(result.telemetry.sovrnStatus, "PRICE_MISMATCH");
  assert.equal(result.telemetry.priceParity, "DIFFERENT");
  assert.equal(result.telemetry.walmartCurrentCents, 9800);
  assert.equal(result.telemetry.sovrnCurrentCents, 12400);
  assert.equal(result.telemetry.deltaCents, 2600);
  assert.equal(result.telemetry.referenceParity, "WALMART_ONLY");
  assert.equal(result.telemetry.finalSource, "WALMART_FALLBACK");
  assert.equal(result.product, source);
});

test("price parity is integer-cent exact with no tolerance", () => {
  assert.equal(moneyCents(79.99), 7999);
  assert.equal(moneyCents(79.99000000000001), 7999);
  assert.equal(moneyCents(79.991), undefined);
  assert.equal(walmartSovrnReferenceParity(undefined, { value: 129.99, currency: "USD", formatted: "$129.99" }), "SOVRN_ONLY");
});

test("identity rejection, missing configuration, and all provider failures preserve Walmart ProductData", async () => {
  const source = sourceProduct();
  const missing = await enrichWalmartWithSovrn({ sourceProduct: source, sourceHtml: sourceHtml(), validateImage: async () => {} });
  assert.equal(missing.telemetry.sovrnStatus, "NOT_CONFIGURED");
  assert.equal(missing.product, source);
  const cases = [
    ["SOVRN_NO_OFFER_FOR_PLAINLINK", "NO_OFFER"],
    ["SOVRN_NO_SAME_RETAILER_OFFER", "NO_SAME_RETAILER"],
    ["SOVRN_VARIANT_CONFLICT", "IDENTITY_REJECTED"],
    ["SOVRN_VARIANT_AMBIGUOUS", "IDENTITY_REJECTED"],
    ["SOVRN_INVALID_PRICE", "INVALID_PRICE"],
    ["SOVRN_TIMEOUT", "TIMEOUT"],
    ["SOVRN_API_ERROR", "PROVIDER_ERROR"]
  ];
  for (const [code, status] of cases) {
    const provider = { product: async () => { throw new ProductError(code, "extraction", "safe"); } };
    const result = await enrichWalmartWithSovrn({ sourceProduct: source, sourceHtml: sourceHtml(), provider, validateImage: async () => {} });
    assert.equal(result.telemetry.sovrnStatus, status);
    assert.equal(result.product, source);
  }
});

test("ambiguous returned identity and invalid downloaded image both force Walmart fallback", async () => {
  const source = sourceProduct();
  const ambiguous = candidateResult();
  ambiguous.identity.variantClassification = "VARIANT_AMBIGUOUS_HIGH_RISK";
  assert.equal((await integrate(source, ambiguous)).telemetry.sovrnStatus, "IDENTITY_REJECTED");
  const invalidImage = await integrate(source, candidateResult(), { validateImage: async () => { throw new ProductError("INVALID_IMAGE_DATA", "render", "bad"); } });
  assert.equal(invalidImage.telemetry.sovrnStatus, "INVALID_IMAGE");
  assert.equal(invalidImage.product, source);
});

test("accepted enrichment preserves exact submitted postUrl and cannot copy Sovrn deeplink metadata", async () => {
  const exact = `${sourceUrl}&keep=EXACT%2Bvalue`;
  const source = sourceProduct({ inputUrl: exact, postUrl: exact });
  const result = await integrate(source, candidateResult({ inputUrl: "https://wrong.example", postUrl: "https://credential-bearing.example/never-use", canonicalProductUrl: "https://comparison.example/item" }));
  assert.equal(result.product.postUrl, exact);
  assert.equal(result.product.inputUrl, exact);
  assert.equal(result.product.canonicalProductUrl, resolvedUrl);
  assert.doesNotMatch(JSON.stringify(result), /credential-bearing|comparison\.example|never-use/);
});

test("Walmart orchestration enriches only after exact parity and emits URL-free decision telemetry", async () => {
  const exactInput = `${resolvedUrl}?affid=original&keep=EXACT%2Bvalue`;
  const sourceImage = "https://i5.walmartimages.com/source.jpeg";
  const enrichedImage = "https://i5.walmartimages.com/enriched.png";
  const html = `<link rel="canonical" href="${resolvedUrl}"><script type="application/ld+json">${JSON.stringify({
    "@type": "Product", name: title, model: "PB045", color: "Black", url: resolvedUrl, image: sourceImage,
    offers: { price: 79.99, priceCurrency: "USD", wasPrice: 89 }
  })}</script>`;
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const logs = [];
  const oldLog = console.log;
  let providerCalls = 0;
  let enrichedImageFetches = 0;
  try {
    console.log = line => logs.push(JSON.parse(line));
    const result = await processProductLink(exactInput, {
      fetcher: async url => {
        const value = String(url);
        if (value === exactInput) return new Response(html, { headers: { "content-type": "text/html" } });
        if (value === enrichedImage) { enrichedImageFetches++; return new Response(png, { headers: { "content-type": "image/png" } }); }
        throw new Error(`unexpected fetch host ${new URL(value).hostname}`);
      },
      dnsCheck: async () => {},
      sovrnProductProvider: { product: async providerInput => {
        providerCalls++;
        assert.equal(providerInput.sourceProduct.currentPrice.value, 79.99);
        assert.equal(providerInput.sourceProduct.postUrl, exactInput);
        return candidateResult({ rawTitle: "Validated Sovrn Ninja PB045 Black", imageUrl: enrichedImage });
      } },
      copyProvider: { generate: async rawTitle => { assert.equal(rawTitle, "Validated Sovrn Ninja PB045 Black"); return { shortTitle: "Ninja PB045 Coffee Maker" }; } },
      renderer: { screenshot: async () => ({ bytes: png, mimeType: "image/png" }) },
      disclosure: "#Ad", requestId: "walmart-sovrn-orchestration"
    });
    assert.equal(providerCalls, 1);
    assert.equal(enrichedImageFetches, 2);
    assert.equal(result.product.currentPrice.value, 79.99);
    assert.equal(result.product.oldPrice.value, 89);
    assert.equal(result.product.imageUrl, enrichedImage);
    assert.equal(result.product.postUrl, exactInput);
    assert.ok(result.content.facebookComment.endsWith(exactInput));
    const decision = logs.find(item => item.event === "walmart_sovrn_decision");
    assert.deepEqual(decision, {
      requestId: "walmart-sovrn-orchestration", event: "walmart_sovrn_decision", sovrnStatus: "ACCEPTED",
      identityClassification: "EXACT_VARIANT_MATCH", priceParity: "EXACT", walmartCurrentCents: 7999,
      sovrnCurrentCents: 7999, deltaCents: 0, referenceParity: "EXACT", sovrnImageValid: true,
      finalSource: "SOVRN_ENRICHED"
    });
    assert.doesNotMatch(JSON.stringify(decision), /https?:|affid|deeplink|secret|chat/i);
  } finally { console.log = oldLog; }
});

test("non-affiliatable Walmart offer is never enabled", async () => {
  await rejectCode(providerFor([offer({ affiliatable: false })]).provider.product(input()), "SOVRN_NO_SAME_RETAILER_OFFER");
});

test("provider/API error is bounded and does not retry non-429 status", async () => {
  const fixture = providerFor([], { status: 500 });
  await rejectCode(fixture.provider.product(input()), "SOVRN_API_ERROR");
  assert.equal(fixture.calls(), 1);
});

test("Sovrn deeplink never becomes postUrl and exact submitted Walmart URL remains", async () => {
  const original = `${sourceUrl}&keep=EXACT%2Bvalue`;
  const product = (await providerFor([offer()]).provider.product(input({ postUrl: original }))).product;
  assert.equal(product.postUrl, original);
  assert.equal(product.inputUrl, original);
  assert.doesNotMatch(JSON.stringify(product), /credential-bearing|never-use/);
});

test("shared Facebook and Telegram copy behavior remains unchanged for normalized Walmart ProductData", async () => {
  const product = (await providerFor([offer()]).provider.product(input())).product;
  const post = buildFacebookPost(product, "Ninja Coffee Maker", "okayyy {{SHORT_TITLE}} for {{PRICE}}?! {{RETAILER}} is wild 😂🔥");
  const comment = buildFacebookComment(product);
  assert.equal(post, "okayyy Ninja Coffee Maker for $79.99?! Walmart is wild 😂🔥");
  assert.doesNotMatch(post, /#Ad|https?:\/\//);
  assert.ok(comment.endsWith(sourceUrl));
  assert.equal((comment.match(/#Ad/g) ?? []).length, 1);
});

test("Amazon keeps its Creators provider while Sovrn runtime is scoped to Walmart and Home Depot", () => {
  const orchestration = readFileSync(path.join(process.cwd(), "src/orchestration/process-product-link.ts"), "utf8");
  assert.match(orchestration, /amazonProductProvider/);
  assert.match(orchestration, /if \(store === "walmart"\)[\s\S]*enrichWalmartWithSovrn/);
  assert.match(orchestration, /store === "homedepot"[\s\S]*sourceHomeDepotWithSovrn/);
  assert.doesNotMatch(orchestration, /store === "amazon"[\s\S]{0,300}enrich(?:Walmart|HomeDepot)WithSovrn/);
});

test("Sovrn client uses official Price Comparison contract without leaking credentials", async () => {
  const logs = [];
  const oldLog = console.log;
  let request;
  try {
    console.log = value => logs.push(String(value));
    const client = new SovrnClient(config, async (url, init) => { request = { url: String(url), init }; return Response.json([offer()]); });
    await client.compareByPlainlink({ plainlink: resolvedUrl, store: "walmart", requestId: "safe" });
  } finally { console.log = oldLog; }
  assert.match(request.url, /\/sites\/site-value\/compare\/prices\/usd_en\/by\/accuracy/);
  assert.equal(new URL(request.url).searchParams.get("plainlink"), resolvedUrl);
  assert.equal(request.init.headers.authorization, "secret secret-value");
  assert.doesNotMatch(logs.join("\n"), /secret-value|site-value|Authorization|credential-bearing/i);
});

test("Walmart extractor remains production authority before optional Sovrn enrichment", () => {
  const orchestration = readFileSync(path.join(process.cwd(), "src/orchestration/process-product-link.ts"), "utf8");
  assert.match(orchestration, /extractWalmartProduct/);
  assert.ok(orchestration.indexOf("extractWalmartProduct") < orchestration.indexOf("enrichWalmartWithSovrn"));
});

test("production workflow expects the three exact Sovrn binding names without embedded values", () => {
  const workflow = readFileSync(path.join(process.cwd(), ".github/workflows/production-deploy.yml"), "utf8");
  for (const name of ["SOVRN_SECRET_KEY", "SOVRN_SITE_API_KEY", "SOVRN_MARKET"]) assert.match(workflow, new RegExp(name, "g"));
  assert.match(workflow, /SOVRN_MARKET must be usd_en/);
  assert.match(workflow, /Walmart fallback remains active/);
  assert.doesNotMatch(workflow, /Authorization:\s*secret|comparisons\.sovrn\.com/);
});
