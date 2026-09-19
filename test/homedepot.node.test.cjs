const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const req = relative => require(path.join(process.env.COMPILED_ROOT, relative));

const { extractHomeDepotProduct, homeDepotProductId, inspectHomeDepotProduct } = req("stores/homedepot/extractor.js");
const { PriceComparisonSovrnProductProvider } = req("stores/sovrn/product-provider.js");
const { SovrnClient } = req("stores/sovrn/client.js");
const { buildSovrnPlainlink } = req("stores/sovrn/plainlink.js");
const { merchantMatchesStore, sovrnStoreForHostname } = req("stores/sovrn/merchant-registry.js");
const { assessSovrnIdentity, inspectSovrnSource } = req("stores/sovrn/source-identity.js");
const { assessHomeDepotSovrnParity } = req("stores/homedepot/sovrn-feasibility.js");
const { enrichHomeDepotWithSovrn } = req("stores/homedepot/sovrn-integration.js");
const { inspectHomeDepotFetchResponse } = req("stores/homedepot/fetch-diagnostics.js");
const { detectStore } = req("stores/detect-store.js");
const { processProductLink } = req("orchestration/process-product-link.js");
const { ProductError } = req("types.js");

const productUrl = "https://www.homedepot.com/p/Husky-Garage-Cabinet-G2802W-US/206288225";
const submittedUrl = `${productUrl}?cm_mmc=affiliate&keep=EXACT%2Bvalue`;
const title = "Husky Ready-to-Assemble 24-Gauge Steel Wall Mounted Garage Cabinet in Black (28 in. W x 29.7 in. H x 12 in. D)";
const image = "https://images.thdstatic.com/productImages/husky-g2802w-us.jpeg";
const product = (overrides = {}) => ({
  "@context": "https://schema.org", "@type": "Product", productID: "206288225", sku: "206288225",
  name: title, mpn: "G2802W-US", brand: { "@type": "Brand", name: "Husky" }, category: "Garage Cabinet",
  color: "Black", material: "24-Gauge Steel", url: productUrl, image,
  additionalProperty: [
    { "@type": "PropertyValue", name: "Width", value: "28 in." },
    { "@type": "PropertyValue", name: "Height", value: "29.7 in." },
    { "@type": "PropertyValue", name: "Depth", value: "12 in." },
    { "@type": "PropertyValue", name: "Mounting Type", value: "Wall Mounted" }
  ],
  offers: {
    "@type": "Offer", price: 134.10, priceCurrency: "USD",
    priceSpecification: [{ "@type": "UnitPriceSpecification", priceType: "ListPrice", price: 149, priceCurrency: "USD" }]
  },
  ...overrides
});
const fixture = (products = [product()], canonical = productUrl) =>
  `<link rel="canonical" href="${canonical}"><script type="application/ld+json">${JSON.stringify({ "@graph": products })}</script>`;

test("Home Depot fetch diagnostics classify bounded HTTP failures without exposing body content", async () => {
  const forbidden = await inspectHomeDepotFetchResponse(
    new Response("Access denied. Verify you are human.", { status: 403, headers: { "content-type": "text/html; charset=utf-8" } }),
    productUrl,
    2
  );
  assert.equal(forbidden.error.code, "STORE_HTTP_ERROR");
  assert.deepEqual(forbidden.diagnostics, {
    event: "homedepot_fetch_diagnostics", httpStatus: 403, responseOk: false,
    normalizedContentType: "text/html", responseByteLength: 36, redirectCount: 2,
    finalHostIsHomeDepot: true, challengeIndicator: true,
    responseClass: "CHALLENGE_OR_INTERSTITIAL"
  });
  assert.doesNotMatch(JSON.stringify(forbidden.diagnostics), /access denied|verify you are human|https?:\/\//i);

  const rateLimited = await inspectHomeDepotFetchResponse(new Response("busy", { status: 429 }), productUrl, 0);
  assert.equal(rateLimited.diagnostics.responseClass, "RATE_LIMITED");
  assert.equal(rateLimited.diagnostics.challengeIndicator, false);

  const unavailable = await inspectHomeDepotFetchResponse(new Response("busy", { status: 503 }), productUrl, 0);
  assert.equal(unavailable.diagnostics.responseClass, "SERVICE_UNAVAILABLE");
});

test("Home Depot fetch diagnostics classify successful HTML and non-HTML responses", async () => {
  const html = await inspectHomeDepotFetchResponse(
    new Response(fixture(), { headers: { "content-type": "text/html; charset=utf-8" } }), productUrl, 0
  );
  assert.equal(html.error, undefined);
  assert.equal(html.html, fixture());
  assert.equal(html.diagnostics.responseClass, "SUCCESS_HTML");
  assert.equal(html.diagnostics.responseByteLength, new TextEncoder().encode(fixture()).byteLength);

  const nonHtml = await inspectHomeDepotFetchResponse(
    new Response("{}", { headers: { "content-type": "application/json" } }), productUrl, 0
  );
  assert.equal(nonHtml.error.code, "NOT_HTML");
  assert.equal(nonHtml.diagnostics.responseClass, "NON_HTML");
});

test("Home Depot product identity is the terminal numeric Internet number", () => {
  assert.equal(detectStore(productUrl), "homedepot");
  assert.equal(detectStore("https://homedepot.example.com/p/item/206288225"), undefined);
  assert.equal(homeDepotProductId(productUrl), "206288225");
  assert.equal(homeDepotProductId("https://www.homedepot.com/b/Tools/123"), undefined);
  assert.equal(homeDepotProductId("https://example.com/p/item/206288225"), undefined);
});

test("Home Depot selected product evidence is tied to Internet number and model", () => {
  const evidence = inspectHomeDepotProduct(fixture(), productUrl);
  assert.deepEqual(evidence, {
    productId: "206288225", model: "G2802W-US", color: "Black",
    brand: "Husky", productFamily: "Garage Cabinet",
    dimensions: { width: 28, height: 29.7, depth: 12, unit: "in" },
    construction: { gauge: 24, material: "24-Gauge Steel" }, mounting: "Wall Mounted", packCount: undefined,
    configuration: ["Black", "24-Gauge Steel", "Width: 28 in.", "Height: 29.7 in.", "Depth: 12 in."],
    canonicalProductUrl: productUrl
  });
});

test("Home Depot extractor maps current and explicit higher reference price and preserves postUrl", () => {
  const result = extractHomeDepotProduct(fixture(), submittedUrl, productUrl);
  assert.equal(result.store, "homedepot");
  assert.equal(result.rawTitle, title);
  assert.deepEqual(result.currentPrice, { value: 134.1, currency: "USD", formatted: "$134.10" });
  assert.deepEqual(result.oldPrice, { value: 149, currency: "USD", formatted: "$149.00" });
  assert.equal(result.imageUrl, image);
  assert.equal(result.homeDepot.productId, "206288225");
  assert.equal(result.homeDepot.model, "G2802W-US");
  assert.equal(result.homeDepot.color, "Black");
  assert.deepEqual(result.homeDepot.dimensions, { width: 28, height: 29.7, depth: 12, unit: "in" });
  assert.equal(result.postUrl, submittedUrl);
  assert.equal(result.canonicalProductUrl, productUrl);
});

test("Home Depot sibling records never supply selected identity, price, or image", () => {
  const sibling = product({ productID: "999999999", sku: "999999999", mpn: "OTHER", color: "White", url: "https://www.homedepot.com/p/Other/999999999", image: "https://images.thdstatic.com/sibling.jpeg", offers: { price: 1, priceCurrency: "USD" } });
  const result = extractHomeDepotProduct(fixture([sibling, product()]), submittedUrl, productUrl);
  assert.equal(result.currentPrice.value, 134.1);
  assert.equal(result.imageUrl, image);
  assert.doesNotMatch(result.rawTitle, /Other/);
});

test("Home Depot canonical, selected identity, ambiguity, and model fail closed", () => {
  assert.throws(() => extractHomeDepotProduct(fixture([product()], "https://www.homedepot.com/p/Other/999999999"), submittedUrl, productUrl), { code: "HOMEDEPOT_PRODUCT_MISMATCH" });
  assert.throws(() => extractHomeDepotProduct(fixture([product({ productID: "999999999", sku: "999999999" })]), submittedUrl, productUrl), { code: "HOMEDEPOT_PRODUCT_MISMATCH" });
  assert.throws(() => extractHomeDepotProduct(fixture([product(), product()]), submittedUrl, productUrl), { code: "HOMEDEPOT_PRODUCT_MISMATCH" });
  assert.throws(() => extractHomeDepotProduct(fixture([product({ mpn: undefined })]), submittedUrl, productUrl), { code: "HOMEDEPOT_PRODUCT_MISMATCH" });
});

test("Home Depot prices and image stay bound to the selected product record", () => {
  assert.throws(() => extractHomeDepotProduct(fixture([product({ offers: [{ price: 134.1, priceCurrency: "USD" }, { price: 149, priceCurrency: "USD" }] })]), submittedUrl, productUrl), { code: "MISSING_PRICE" });
  assert.throws(() => extractHomeDepotProduct(fixture([product({ image: "http://images.thdstatic.com/unsafe.jpeg" })]), submittedUrl, productUrl), { code: "MISSING_IMAGE" });
  const noReference = extractHomeDepotProduct(fixture([product({ offers: { price: 134.1, priceCurrency: "USD", listPrice: 134.1 } })]), submittedUrl, productUrl);
  assert.equal(noReference.oldPrice, undefined);
});

test("Home Depot Sovrn adapter strips tracking and enforces canonical merchant aliases", () => {
  assert.equal(sovrnStoreForHostname("www.homedepot.com"), "homedepot");
  assert.equal(merchantMatchesStore("homedepot", "The Home Depot"), true);
  assert.equal(merchantMatchesStore("homedepot", "Home Depot"), true);
  assert.equal(merchantMatchesStore("homedepot", "Other Merchant"), false);
  const lookup = buildSovrnPlainlink(submittedUrl, "homedepot");
  assert.equal(lookup.productIdentity, "206288225");
  assert.equal(lookup.plainlink, `${productUrl}?keep=EXACT%2Bvalue`);
});

test("Home Depot provider accepts only The Home Depot and matching model/configuration", async () => {
  const source = extractHomeDepotProduct(fixture(), submittedUrl, productUrl);
  const offers = [
    { merchant: { name: "Other Merchant", id: 1 }, name: title, salePrice: 1, retailPrice: 2, currency: "USD", affiliatable: true, image },
    { merchant: { name: "The Home Depot", id: 123 }, name: `${title} G2802W-US`, salePrice: 134.10, retailPrice: 149, currency: "USD", affiliatable: true, image }
  ];
  const provider = new PriceComparisonSovrnProductProvider(new SovrnClient(
    { secretKey: "secret", siteApiKey: "site", market: "usd_en" }, async () => Response.json(offers)
  ));
  const result = await provider.product({ store: "homedepot", sourceProduct: source, postUrl: submittedUrl, resolvedUrl: productUrl, sourceHtml: fixture() });
  assert.equal(result.product.currentPrice.value, 134.1);
  assert.equal(result.product.oldPrice.value, 149);
  assert.equal(result.product.postUrl, submittedUrl);
  assert.equal(result.identity.variantClassification, "EXACT_VARIANT_MATCH");
  assert.equal(result.identity.productMatchConfirmed, true);
  const aliasOnly = new PriceComparisonSovrnProductProvider(new SovrnClient(
    { secretKey: "secret", siteApiKey: "site", market: "usd_en" },
    async () => Response.json([{ merchant: { name: "Home Depot", id: 123 }, name: `${title} G2802W-US`, salePrice: 134.10, retailPrice: 149, currency: "USD", affiliatable: true, image }])
  ));
  await assert.rejects(
    aliasOnly.product({ store: "homedepot", sourceProduct: source, postUrl: submittedUrl, resolvedUrl: productUrl, sourceHtml: fixture() }),
    { code: "SOVRN_NO_SAME_RETAILER_OFFER" }
  );
});

test("Home Depot exact-cent parity is required by the feasibility decision", () => {
  const cents = value => Number.isFinite(value) ? Math.round(value * 100) : undefined;
  assert.equal(cents(134.10), 13410);
  assert.equal(cents(134.10) === cents(134.10), true);
  assert.equal(cents(134.10) === cents(134.11), false);
  assert.equal(cents(149) === cents(149), true);
});

const sourceEvidence = () => {
  const source = extractHomeDepotProduct(fixture(), submittedUrl, productUrl);
  return {
    source,
    evidence: inspectSovrnSource({ store: "homedepot", sourceProduct: source, postUrl: submittedUrl, resolvedUrl: productUrl, html: fixture() })
  };
};
const wireOffer = (overrides = {}) => ({
  merchantName: "The Home Depot", merchantId: 1061, title,
  salePrice: 134.10, retailPrice: 149, currency: "USD", affiliatable: true,
  imageUrl: image, stockState: "unknown", identity: {}, ...overrides
});

test("Home Depot missing Sovrn model accepts all independently matching configuration groups", () => {
  const { evidence } = sourceEvidence();
  const result = assessSovrnIdentity(evidence, wireOffer());
  assert.equal(result.productMatchConfirmed, true);
  assert.equal(result.variantClassification, "NO_VARIANT_CONFLICT");
});

test("Home Depot equal models are exact while an explicit model conflict rejects", () => {
  const { evidence } = sourceEvidence();
  assert.equal(assessSovrnIdentity(evidence, wireOffer({ identity: { mpn: "G2802W-US" } })).variantClassification, "EXACT_VARIANT_MATCH");
  const conflict = assessSovrnIdentity(evidence, wireOffer({ identity: { mpn: "OTHER-MODEL" } }));
  assert.equal(conflict.productMatchConfirmed, false);
  assert.equal(conflict.variantClassification, "VARIANT_CONFLICT");
});

test("Home Depot dimension, color, construction, and mounting conflicts reject independently", () => {
  const { evidence } = sourceEvidence();
  for (const conflictingTitle of [
    title.replace("28 in. W", "30 in. W"),
    title.replace("Black", "White"),
    title.replace("24-Gauge Steel", "20-Gauge Steel"),
    title.replace("Wall Mounted", "Freestanding")
  ]) {
    const result = assessSovrnIdentity(evidence, wireOffer({ title: conflictingTitle }));
    assert.equal(result.productMatchConfirmed, false, conflictingTitle);
    assert.equal(result.variantClassification, "VARIANT_CONFLICT", conflictingTitle);
  }
});

test("Home Depot weak title-only evidence remains ambiguous when model is missing", () => {
  const { evidence } = sourceEvidence();
  const result = assessSovrnIdentity(evidence, wireOffer({ title: "Husky Garage Cabinet in Black" }));
  assert.equal(result.productMatchConfirmed, false);
  assert.equal(result.variantClassification, "VARIANT_AMBIGUOUS_HIGH_RISK");
});

test("Home Depot identity does not depend on price and exact-cent parity is a separate gate", () => {
  const { source, evidence } = sourceEvidence();
  const identity = assessSovrnIdentity(evidence, wireOffer({ salePrice: 1, retailPrice: 2 }));
  assert.equal(identity.variantClassification, "NO_VARIANT_CONFLICT");
  const matchingCandidate = { ...source, currentPrice: { value: 134.10, currency: "USD", formatted: "$134.10" }, oldPrice: { value: 149, currency: "USD", formatted: "$149.00" } };
  assert.deepEqual(assessHomeDepotSovrnParity(source, matchingCandidate, identity), {
    eligible: true, currentParity: "EXACT", referenceParity: "EXACT",
    homeDepotCurrentCents: 13410, sovrnCurrentCents: 13410, deltaCents: 0
  });
  const staleCandidate = { ...matchingCandidate, currentPrice: { value: 149, currency: "USD", formatted: "$149.00" } };
  assert.deepEqual(assessHomeDepotSovrnParity(source, staleCandidate, identity), {
    eligible: false, currentParity: "DIFFERENT", referenceParity: "EXACT",
    homeDepotCurrentCents: 13410, sovrnCurrentCents: 14900, deltaCents: 1490
  });
});

const candidateResult = (source, overrides = {}) => ({
  product: {
    ...source,
    rawTitle: "Validated Sovrn Husky Wall Cabinet",
    imageUrl: "https://images.thdstatic.com/enriched.jpeg",
    currentPrice: { value: 134.10, currency: "USD", formatted: "$134.10" },
    oldPrice: { value: 149, currency: "USD", formatted: "$149.00" },
    inputUrl: "https://should-not-survive.example/input",
    postUrl: "https://should-not-survive.example/post",
    resolvedUrl: "https://should-not-survive.example/resolved",
    canonicalProductUrl: "https://should-not-survive.example/canonical",
    ...overrides
  },
  identity: {
    productMatchConfirmed: true,
    variantClassification: "NO_VARIANT_CONFLICT",
    sourceVariant: { explicit: true },
    offerVariant: { explicit: true }
  },
  merchantId: 1061
});

test("Home Depot accepted enrichment changes only title and image after exact parity", async () => {
  const source = extractHomeDepotProduct(fixture(), submittedUrl, productUrl);
  const decision = await enrichHomeDepotWithSovrn({
    sourceProduct: source,
    sourceHtml: fixture(),
    provider: { product: async () => candidateResult(source) },
    validateImage: async url => assert.equal(url, "https://images.thdstatic.com/enriched.jpeg")
  });
  assert.equal(decision.telemetry.sovrnStatus, "ACCEPTED");
  assert.equal(decision.telemetry.finalSource, "SOVRN_ENRICHED");
  assert.equal(decision.telemetry.priceParity, "EXACT");
  assert.equal(decision.telemetry.referenceParity, "EXACT");
  assert.equal(decision.product.rawTitle, "Validated Sovrn Husky Wall Cabinet");
  assert.equal(decision.product.imageUrl, "https://images.thdstatic.com/enriched.jpeg");
  assert.equal(decision.product.currentPrice.value, 134.10);
  assert.equal(decision.product.oldPrice.value, 149);
  assert.equal(decision.product.postUrl, submittedUrl);
  assert.equal(decision.product.resolvedUrl, productUrl);
  assert.equal(decision.product.canonicalProductUrl, productUrl);
  assert.doesNotMatch(JSON.stringify(decision.product), /should-not-survive/);
});

test("Home Depot model, dimension, color, and configuration conflicts all fall back", async () => {
  const source = extractHomeDepotProduct(fixture(), submittedUrl, productUrl);
  for (const code of ["MODEL", "DIMENSION", "COLOR", "CONFIGURATION"]) {
    const decision = await enrichHomeDepotWithSovrn({
      sourceProduct: source,
      sourceHtml: fixture(),
      provider: { product: async () => { throw new ProductError("SOVRN_VARIANT_CONFLICT", "extraction", code); } },
      validateImage: async () => { throw new Error("must not validate"); }
    });
    assert.equal(decision.telemetry.sovrnStatus, "IDENTITY_REJECTED", code);
    assert.equal(decision.telemetry.finalSource, "HOME_DEPOT_FALLBACK", code);
    assert.equal(decision.product, source, code);
  }
});

test("Home Depot current mismatch and invalid image fall back without exposing Sovrn fields", async () => {
  const source = extractHomeDepotProduct(fixture(), submittedUrl, productUrl);
  const mismatch = await enrichHomeDepotWithSovrn({
    sourceProduct: source,
    sourceHtml: fixture(),
    provider: { product: async () => candidateResult(source, { currentPrice: { value: 135, currency: "USD", formatted: "$135.00" } }) },
    validateImage: async () => {}
  });
  assert.equal(mismatch.telemetry.sovrnStatus, "PRICE_MISMATCH");
  assert.equal(mismatch.telemetry.deltaCents, 90);
  assert.equal(mismatch.telemetry.finalSource, "HOME_DEPOT_FALLBACK");
  assert.equal(mismatch.product, source);
  const wrongCurrency = await enrichHomeDepotWithSovrn({
    sourceProduct: source,
    sourceHtml: fixture(),
    provider: { product: async () => candidateResult(source, { currentPrice: { value: 134.10, currency: "CAD", formatted: "CA$134.10" } }) },
    validateImage: async () => {}
  });
  assert.equal(wrongCurrency.telemetry.sovrnStatus, "INVALID_PRICE");
  assert.equal(wrongCurrency.telemetry.priceParity, "UNAVAILABLE");
  assert.equal(wrongCurrency.product, source);
  const invalidImage = await enrichHomeDepotWithSovrn({
    sourceProduct: source,
    sourceHtml: fixture(),
    provider: { product: async () => candidateResult(source) },
    validateImage: async () => { throw new Error("bad image"); }
  });
  assert.equal(invalidImage.telemetry.sovrnStatus, "INVALID_IMAGE");
  assert.equal(invalidImage.product, source);
});

test("Home Depot suppresses Sovrn-only reference and fails open for empty, timeout, provider, and missing config", async () => {
  const source = { ...extractHomeDepotProduct(fixture(), submittedUrl, productUrl), oldPrice: undefined };
  const accepted = await enrichHomeDepotWithSovrn({
    sourceProduct: source,
    sourceHtml: fixture(),
    provider: { product: async () => candidateResult(source, { oldPrice: { value: 149, currency: "USD", formatted: "$149.00" } }) },
    validateImage: async () => {}
  });
  assert.equal(accepted.telemetry.referenceParity, "SOVRN_ONLY");
  assert.equal(accepted.product.oldPrice, undefined);
  for (const [errorCode, status] of [
    ["SOVRN_NO_OFFER_FOR_PLAINLINK", "NO_OFFER"],
    ["SOVRN_TIMEOUT", "TIMEOUT"],
    ["SOVRN_API_ERROR", "PROVIDER_ERROR"]
  ]) {
    const decision = await enrichHomeDepotWithSovrn({
      sourceProduct: source,
      sourceHtml: fixture(),
      provider: { product: async () => { throw new ProductError(errorCode, "extraction", "safe"); } },
      validateImage: async () => {}
    });
    assert.equal(decision.telemetry.sovrnStatus, status);
    assert.equal(decision.product, source);
  }
  const missing = await enrichHomeDepotWithSovrn({ sourceProduct: source, sourceHtml: fixture(), validateImage: async () => {} });
  assert.equal(missing.telemetry.sovrnStatus, "NOT_CONFIGURED");
  assert.equal(missing.product, source);
});

test("Home Depot runs through shared card and social output with exact original postUrl", async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const trackerUrl = "https://tracker.example.org/home-depot?id=exact-original";
  const logs = [];
  const oldLog = console.log;
  try {
    console.log = line => logs.push(JSON.parse(line));
    const result = await processProductLink(trackerUrl, {
      fetcher: async url => {
        const value = String(url);
        if (value === trackerUrl) return new Response(null, { status: 302, headers: { location: productUrl } });
        if (value === productUrl) return new Response(fixture(), { headers: { "content-type": "text/html" } });
        if (value === "https://images.thdstatic.com/enriched.jpeg") return new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "image/jpeg" } });
        throw new Error(`unexpected URL ${value}`);
      },
      dnsCheck: async () => {},
      sovrnProductProvider: { product: async input => {
        assert.equal(input.store, "homedepot");
        assert.equal(input.sourceProduct.currentPrice.value, 134.10);
        assert.equal(input.postUrl, trackerUrl);
        return candidateResult(input.sourceProduct);
      } },
      copyProvider: { generate: async rawTitle => {
        assert.equal(rawTitle, "Validated Sovrn Husky Wall Cabinet");
        return { shortTitle: "Husky Wall Cabinet", facebookHookTemplate: "okayyy {{SHORT_TITLE}} for {{PRICE}}?! 👀" };
      } },
      renderer: { screenshot: async (_html, width, height) => {
        assert.equal(width, 1200);
        assert.equal(height, 1200);
        return { bytes: png, mimeType: "image/png" };
      } },
      disclosure: "#Ad",
      requestId: "homedepot-runtime"
    });
    assert.equal(result.product.store, "homedepot");
    assert.equal(result.product.postUrl, trackerUrl);
    assert.equal(result.product.currentPrice.formatted, "$134.10");
    assert.equal(result.product.oldPrice.formatted, "$149.00");
    assert.equal(result.product.homeDepot.productId, "206288225");
    assert.equal(result.product.homeDepot.model, "G2802W-US");
    assert.doesNotMatch(result.content.facebookPost, /#Ad|https?:\/\//);
    assert.ok(result.content.facebookComment.endsWith(trackerUrl));
    const decision = logs.find(item => item.event === "homedepot_sovrn_decision");
    assert.equal(decision.finalSource, "SOVRN_ENRICHED");
    assert.doesNotMatch(JSON.stringify(decision), /https?:|deeplink|secret|chat/i);
    const fetchDiagnostic = logs.find(item => item.event === "homedepot_fetch_diagnostics");
    assert.deepEqual(fetchDiagnostic, {
      event: "homedepot_fetch_diagnostics", requestId: "homedepot-runtime",
      httpStatus: 200, responseOk: true, normalizedContentType: "text/html",
      responseByteLength: new TextEncoder().encode(fixture()).byteLength,
      redirectCount: 1, finalHostIsHomeDepot: true, challengeIndicator: false,
      responseClass: "SUCCESS_HTML"
    });
  } finally { console.log = oldLog; }
});
