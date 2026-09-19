const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const req = relative => require(path.join(process.env.COMPILED_ROOT, relative));

const { extractHomeDepotProduct, homeDepotProductId, inspectHomeDepotProduct } = req("stores/homedepot/extractor.js");
const { PriceComparisonSovrnProductProvider } = req("stores/sovrn/product-provider.js");
const { SovrnClient } = req("stores/sovrn/client.js");
const { sourceHomeDepotWithSovrn } = req("stores/homedepot/sovrn-integration.js");
const { homeDepotIdentityFromUrl } = req("stores/homedepot/url-identity.js");
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


const fullProductUrl = "https://www.homedepot.com/p/Husky-Ready-to-Assemble-24-Gauge-Steel-Wall-Mounted-Garage-Cabinet-in-Black-28-in-W-x-29-7-in-H-x-12-in-D-G2802W-US/206288225";
const sovrnTitle = "Husky Ready-to-Assemble 24-Gauge Steel Wall Mounted Garage Cabinet in Black 28 in. W x 29.7 in. H x 12 in. D";
const sovrnOffer = (overrides = {}) => ({
  merchant: { name: "The Home Depot", id: 1061 }, name: sovrnTitle,
  salePrice: 134.10, retailPrice: 149, currency: "USD", affiliatable: true,
  image, ...overrides
});
const providerFor = offers => new PriceComparisonSovrnProductProvider(new SovrnClient(
  { secretKey: "secret", siteApiKey: "site", market: "usd_en" }, async () => Response.json(offers)
));
const providerInput = (resolvedUrl = fullProductUrl, postUrl = submittedUrl) => {
  return { store: "homedepot", postUrl, resolvedUrl };
};



test("Home Depot runtime URL identity uses only the terminal Internet number", () => {
  assert.deepEqual(homeDepotIdentityFromUrl(fullProductUrl), { productId: "206288225", productIdConfirmed: true });
  assert.deepEqual(homeDepotIdentityFromUrl("https://www.homedepot.com/p/Fake-Brand-Red-Wrong-Model/206288225"), {
    productId: "206288225", productIdConfirmed: true
  });
  assert.deepEqual(homeDepotIdentityFromUrl("https://www.homedepot.com/p/product/206288225"), {
    productId: "206288225", productIdConfirmed: true
  });
});

test("Home Depot direct and tracker routes avoid the blocked PDP and preserve exact postUrl", async () => {
  const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  for (const input of [fullProductUrl, "https://tracker.example.org/home-depot?id=exact-original"]) {
    let pdpFetches = 0;
    const logs = [];
    const oldLog = console.log;
    try {
      console.log = line => logs.push(JSON.parse(line));
      const result = await processProductLink(input, {
        fetcher: async url => {
          const value = String(url);
          if (value.startsWith("https://tracker.example.org/")) return new Response(null, { status: 302, headers: { location: fullProductUrl } });
          if (value === fullProductUrl) { pdpFetches++; throw new Error("PDP must not be fetched"); }
          if (value === image) return new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "image/jpeg" } });
          throw new Error("unexpected URL " + value);
        },
        dnsCheck: async () => {}, sovrnProductProvider: providerFor([sovrnOffer()]),
        copyProvider: { generate: async () => ({ shortTitle: "Husky Wall Cabinet", facebookHookTemplate: "{{SHORT_TITLE}} {{PRICE}} 👀" }) },
        renderer: { screenshot: async () => ({ bytes: png, mimeType: "image/png" }) },
        disclosure: "#Ad", requestId: "homedepot-sovrn-primary"
      });
      assert.equal(pdpFetches, 0);
      assert.equal(result.product.postUrl, input);
      assert.equal(result.product.currentPrice.formatted, "$134.10");
      assert.equal(result.product.oldPrice.formatted, "$149.00");
      assert.deepEqual(result.product.homeDepot, { productId: "206288225" });
      assert.equal(logs.find(item => item.event === "homedepot_sovrn_decision").finalSource, "SOVRN_PRIMARY");
      assert.equal(logs.some(item => item.event === "homedepot_fetch_diagnostics"), false);
    } finally { console.log = oldLog; }
  }
});

test("Home Depot provider selects only exact The Home Depot merchant and ignores alternatives", async () => {
  const result = await providerFor([
    sovrnOffer({ merchant: { name: "Other Merchant" }, salePrice: 1 }),
    sovrnOffer({ affiliatable: false })
  ]).product(providerInput());
  assert.equal(result.sameRetailerOfferCount, 1);
  assert.equal(result.product.currentPrice.value, 134.1);
  assert.equal(result.product.oldPrice.value, 149);
  assert.equal(result.product.postUrl, submittedUrl);
  assert.equal(result.identity.productMatchConfirmed, true);
});

test("no canonical Home Depot offer fails closed", async () => {
  for (const offers of [[], [sovrnOffer({ merchant: { name: "Home Depot" } })], [sovrnOffer({ merchant: { name: "Other Merchant" } })]]) {
    await assert.rejects(providerFor(offers).product(providerInput()), {
      code: offers.length ? "SOVRN_NO_SAME_RETAILER_OFFER" : "SOVRN_NO_OFFER_FOR_PLAINLINK"
    });
  }
});

test("multiple canonical Home Depot offers fail closed as ambiguous", async () => {
  await assert.rejects(providerFor([
    sovrnOffer(),
    sovrnOffer({ merchant: { name: "The Home Depot", id: 1062 }, salePrice: 130 })
  ]).product(providerInput()), { code: "HOME_DEPOT_AMBIGUOUS_OFFER" });
});

test("Home Depot salePrice is authoritative only when positive USD and cent safe", async () => {
  const accepted = await providerFor([sovrnOffer()]).product(providerInput());
  assert.deepEqual(accepted.product.currentPrice, { value: 134.1, currency: "USD", formatted: "$134.10" });
  for (const patch of [
    { salePrice: 0 }, { salePrice: -1 }, { salePrice: 12.345 },
    { salePrice: null }, { salePrice: "134.10" }, { currency: "CAD" }
  ]) {
    await assert.rejects(providerFor([sovrnOffer(patch)]).product(providerInput()), { code: "SOVRN_INVALID_PRICE" });
  }
});

test("Home Depot reference price is accepted only when cent-safe and higher than current", async () => {
  const accepted = await providerFor([sovrnOffer()]).product(providerInput());
  assert.deepEqual(accepted.product.oldPrice, { value: 149, currency: "USD", formatted: "$149.00" });
  assert.equal(accepted.referencePriceStatus, "VALID");
  for (const retailPrice of [134.10, 100, 0, 149.001, null, "149"]) {
    const result = await providerFor([sovrnOffer({ retailPrice })]).product(providerInput());
    assert.equal(result.product.oldPrice, undefined);
    assert.ok(["ABSENT", "SUPPRESSED_INVALID"].includes(result.referencePriceStatus));
  }
});

const candidateResult = (overrides = {}) => ({
  product: {
    store: "homedepot", inputUrl: "https://provider.invalid", postUrl: "https://provider.invalid",
    resolvedUrl: "https://provider.invalid", canonicalProductUrl: "https://provider.invalid",
    rawTitle: "Husky Wall Cabinet", imageUrl: image,
    currentPrice: { value: 134.10, currency: "USD", formatted: "$134.10" },
    oldPrice: { value: 149, currency: "USD", formatted: "$149.00" }, ...overrides
  },
  identity: { productMatchConfirmed: true, variantClassification: "NO_VARIANT_CONFLICT", sourceVariant: { explicit: false }, offerVariant: { explicit: false } },
  sameRetailerOfferCount: 1, referencePriceStatus: "VALID"
});

test("Husky Sovrn fixture produces SOVRN_PRIMARY with authoritative prices", async () => {
  const decision = await sourceHomeDepotWithSovrn({
    postUrl: submittedUrl, resolvedUrl: fullProductUrl,
    provider: providerFor([sovrnOffer()]),
    validateImage: async value => assert.equal(value, image)
  });
  assert.equal(decision.error, undefined);
  assert.equal(decision.telemetry.sovrnStatus, "ACCEPTED");
  assert.equal(decision.telemetry.finalSource, "SOVRN_PRIMARY");
  assert.equal(decision.telemetry.currentPriceValid, true);
  assert.equal(decision.telemetry.referencePriceStatus, "VALID");
  assert.equal(decision.product.currentPrice.formatted, "$134.10");
  assert.equal(decision.product.oldPrice.formatted, "$149.00");
  assert.equal(decision.product.postUrl, submittedUrl);
  assert.deepEqual(decision.product.homeDepot, { productId: "206288225" });
});

test("invalid image fails Home Depot closed", async () => {
  const decision = await sourceHomeDepotWithSovrn({
    postUrl: submittedUrl, resolvedUrl: fullProductUrl,
    provider: { product: async () => candidateResult() },
    validateImage: async () => { throw new Error("bad image"); }
  });
  assert.equal(decision.product, undefined);
  assert.equal(decision.telemetry.sovrnStatus, "INVALID_IMAGE");
  assert.equal(decision.telemetry.finalSource, "NONE");
});

test("Home Depot timeout, provider error, empty response, and missing configuration fail closed", async () => {
  for (const [provider, status] of [
    [undefined, "NOT_CONFIGURED"],
    [{ product: async () => { throw new ProductError("SOVRN_TIMEOUT", "extraction", "safe"); } }, "TIMEOUT"],
    [{ product: async () => { throw new ProductError("SOVRN_API_ERROR", "extraction", "safe"); } }, "PROVIDER_ERROR"],
    [providerFor([]), "NO_OFFER"]
  ]) {
    const decision = await sourceHomeDepotWithSovrn({
      postUrl: submittedUrl, resolvedUrl: fullProductUrl, provider, validateImage: async () => {}
    });
    assert.equal(decision.product, undefined);
    assert.equal(decision.telemetry.sovrnStatus, status);
    assert.equal(decision.telemetry.finalSource, "NONE");
  }
});

test("Sovrn deeplink and provider URLs never enter Home Depot ProductData or telemetry", async () => {
  const decision = await sourceHomeDepotWithSovrn({
    postUrl: submittedUrl, resolvedUrl: fullProductUrl,
    provider: { product: async () => candidateResult({ deeplink: "https://sovrn.invalid/private" }) },
    validateImage: async () => {}
  });
  assert.equal(decision.product.postUrl, submittedUrl);
  assert.doesNotMatch(JSON.stringify(decision.product), /sovrn\.invalid|provider\.invalid|deeplink/i);
  assert.doesNotMatch(JSON.stringify(decision.telemetry), /https?:|deeplink|title|chat/i);
});

test("Home Depot telemetry contains only approved SOVRN_PRIMARY decision fields", async () => {
  const decision = await sourceHomeDepotWithSovrn({
    postUrl: submittedUrl, resolvedUrl: fullProductUrl,
    provider: { product: async () => candidateResult() }, validateImage: async () => {}
  });
  assert.deepEqual(decision.telemetry, {
    event: "homedepot_sovrn_decision", sovrnStatus: "ACCEPTED", sameRetailerOfferCount: 1,
    currentPriceValid: true, referencePriceStatus: "VALID", sovrnImageValid: true,
    finalSource: "SOVRN_PRIMARY"
  });
});
