const { test } = require("node:test");
const assert = require("node:assert/strict");
const { join } = require("node:path");
const src = path => require(join(process.env.COMPILED_ROOT, path));
const { detectStore } = src("stores/detect-store.js");
const { resolveUrl, trustedAmazonRedirectAsins } = src("stores/resolve-url.js");
const { amazonAsinFromUrl } = src("stores/amazon/diagnostics.js");
const { resolveAmazonIdentity, trustedAmazonAsin } = src("stores/amazon/identity.js");
const { amazonCardHtml } = src("stores/amazon/template.js");
const { AmazonCreatorsTokenManager, creatorsTokenEndpoint } = src("stores/amazon/creators-token-manager.js");
const { AmazonCreatorsApiClient, AmazonCreatorsAuthError, amazonCreatorsGetItemsEndpoint, amazonCreatorsRetryBounds } = src("stores/amazon/creators-api-client.js");
const { mapCreatorsItem } = src("stores/amazon/creators-api-product.js");
const { AMAZON_CREATORS_RESOURCES } = src("stores/amazon/creators-api-types.js");
const { processProductLink } = src("orchestration/process-product-link.js");
const { buildFacebookComment, buildFacebookPost } = src("ai/build-facebook-post.js");

const saleUrl = "https://www.amazon.com/dp/B08HNBHSQV";
const affiliate = "https://www.amazon.com/dp/B08HNBHSQV?tag=partner-20&th=1";
const shortAffiliate = "https://amzn.to/ExactShortCode";

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

async function resolveChain(urls, finalHtml = "<html></html>") {
  let index = 0;
  return resolveUrl(urls[0], async url => {
    assert.equal(url, urls[index]);
    if (index < urls.length - 1) {
      const location = urls[++index];
      return new Response(null, { status: 302, headers: { location } });
    }
    return new Response(finalHtml, { headers: { "content-type": "text/html" } });
  }, undefined, async () => {});
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

test("Amazon redirect identity preserves a trusted original ASIN across unconfirmed CLP routes", () => {
  const original = "https://www.amazon.com/dp/B08HNBHSQV?tag=partner-20&ref_=pilot";
  const clp = "https://www.amazon.com/clp/B08HNBHSQV";
  assert.equal(trustedAmazonAsin(original), "B08HNBHSQV");
  assert.deepEqual(resolveAmazonIdentity(original, clp, "<html><title>Product</title></html>"), {
    asin: "B08HNBHSQV", sourceIdentityState: "SOURCE_UNCONFIRMED"
  });
  assert.equal(resolveAmazonIdentity(original, clp, '<link rel="canonical" href="https://www.amazon.com/dp/B08HNBHSQV">').sourceIdentityState, "SOURCE_CONFIRMED");
  assert.throws(() => resolveAmazonIdentity(original, clp, '<link rel="canonical" href="https://www.amazon.com/dp/B00MNV8E0C">'), { code: "AMAZON_ASIN_MISMATCH", validationReason: "SOURCE_CONFLICT" });
  assert.throws(() => resolveAmazonIdentity(original, "https://www.amazon.com/dp/B00MNV8E0C"), { code: "AMAZON_ASIN_MISMATCH" });
  assert.throws(() => resolveAmazonIdentity(original, "https://example.com/clp/B08HNBHSQV"), { code: "UNSAFE_AMAZON_URL" });
  assert.throws(() => trustedAmazonAsin("https://amzn.to/ExactShortCode"), { code: "MISSING_PRODUCT_ID" });
});

test("opaque trackers obtain Amazon identity only from the resolved destination or authoritative page evidence", () => {
  const linkAmazon = "https://link.amazon/B019JQ4Xw";
  const joyLink = "https://joylink.io/amazon/amd-ryzen-9-32thread-processor";
  assert.deepEqual(resolveAmazonIdentity(linkAmazon, "https://www.amazon.com/dp/B08HNBHSQV"), {
    asin: "B08HNBHSQV", sourceIdentityState: "SOURCE_CONFIRMED",
    sourceIdentityAsin: "B08HNBHSQV", sourceIdentitySource: "resolved-product-route"
  });
  assert.equal(resolveAmazonIdentity(joyLink, "https://www.amazon.com/gp/product/B08HNBHSQV").asin, "B08HNBHSQV");
  assert.equal(resolveAmazonIdentity(linkAmazon, "https://www.amazon.com/clp/opaque", '<link rel="canonical" href="https://www.amazon.com/dp/B08HNBHSQV">').asin, "B08HNBHSQV");
  assert.throws(() => resolveAmazonIdentity(linkAmazon, "https://www.amazon.com/clp/opaque", "<html></html>"), { code: "MISSING_PRODUCT_ID" });
  assert.throws(() => resolveAmazonIdentity(linkAmazon, "https://example.org/dp/B08HNBHSQV"), { code: "UNSAFE_AMAZON_URL" });
});

test("resolver retains normalized ASIN evidence from followed Amazon product-route redirects", async () => {
  const tracker = "https://joylink.io/amazon/256-gb-flash-drive";
  const asin = "B0D3PNRCMT";
  const clp = "https://www.amazon.com/clp/opaque";

  const dpPage = await resolveChain([tracker, `https://www.amazon.com/dp/${asin}/ref=tracker`, clp]);
  assert.deepEqual(trustedAmazonRedirectAsins(dpPage.trustedAmazonRedirectIdentity), [asin]);
  assert.deepEqual(resolveAmazonIdentity(tracker, dpPage.resolvedUrl, "<html></html>", dpPage.trustedAmazonRedirectIdentity), {
    asin,
    sourceIdentityState: "SOURCE_CONFIRMED",
    sourceIdentityAsin: asin,
    sourceIdentitySource: "intermediate-product-route"
  });

  const gpPage = await resolveChain([tracker, `https://www.amazon.com/gp/product/${asin}`, "https://www.amazon.com/hz/landing"]);
  assert.equal(resolveAmazonIdentity(tracker, gpPage.resolvedUrl, "<html></html>", gpPage.trustedAmazonRedirectIdentity).asin, asin);

  const repeatedPage = await resolveChain([
    tracker,
    `https://www.amazon.com/dp/${asin}`,
    `https://www.amazon.com/gp/product/${asin}`,
    clp
  ]);
  assert.deepEqual(trustedAmazonRedirectAsins(repeatedPage.trustedAmazonRedirectIdentity), [asin]);
  assert.equal(resolveAmazonIdentity(tracker, repeatedPage.resolvedUrl, "<html></html>", repeatedPage.trustedAmazonRedirectIdentity).asin, asin);
});

test("Amazon identity rejects conflicts across intermediate, final, and page evidence", async () => {
  const tracker = "https://tracker.example.com/click/amazon";
  const intermediate = "https://www.amazon.com/dp/B0D3PNRCMT";
  const conflictingFinal = "https://www.amazon.com/dp/B09Y98XQ63";
  const finalConflictPage = await resolveChain([tracker, intermediate, conflictingFinal]);
  assert.throws(
    () => resolveAmazonIdentity(tracker, finalConflictPage.resolvedUrl, undefined, finalConflictPage.trustedAmazonRedirectIdentity),
    { code: "AMAZON_ASIN_MISMATCH", validationReason: "SOURCE_CONFLICT" }
  );

  const clpPage = await resolveChain([tracker, intermediate, "https://www.amazon.com/clp/opaque"]);
  assert.throws(
    () => resolveAmazonIdentity(
      tracker,
      clpPage.resolvedUrl,
      '<link rel="canonical" href="https://www.amazon.com/dp/B09Y98XQ63">',
      clpPage.trustedAmazonRedirectIdentity
    ),
    { code: "AMAZON_ASIN_MISMATCH", validationReason: "SOURCE_CONFLICT" }
  );
});

test("only resolver-originated supported Amazon redirect routes become trusted evidence", async () => {
  const tracker = "https://joylink.io/amazon/B0D3PNRCMT-product-name";
  const page = await resolveChain([
    tracker,
    "https://merchant.example.com/dp/B0D3PNRCMT",
    "https://www.amazon.com/clp/opaque"
  ]);
  assert.deepEqual(trustedAmazonRedirectAsins(page.trustedAmazonRedirectIdentity), []);
  assert.throws(() => resolveAmazonIdentity(tracker, page.resolvedUrl, "<html></html>", page.trustedAmazonRedirectIdentity), { code: "MISSING_PRODUCT_ID" });
  assert.throws(() => resolveAmazonIdentity(tracker, page.resolvedUrl, "<html></html>", {}), { code: "MISSING_PRODUCT_ID" });
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
  assert.equal(product.amazon.savings, undefined);
  assert.equal(product.rawTitle, "ESR HaloLock Magnetic Wireless Car Charger");
  assert.equal(product.postUrl, affiliate);
});

test("Creators LIST_PRICE maps only when it is a positive higher same-currency reference", () => {
  for (const [amount, expected] of [[39.99, "$39.99"], [24.99, undefined], [0, undefined], [20, undefined]]) {
    const product = mapCreatorsItem(creatorsItem({ offersV2: { listings: [creatorsListing({ price: {
      money: { amount: 24.99, currency: "USD", displayAmount: "$24.99" },
      savingBasis: { money: { amount, currency: "USD", displayAmount: `$${amount.toFixed(2)}` }, savingBasisType: "LIST_PRICE", savingBasisTypeLabel: "List Price" }
    } })] } }), "B08HNBHSQV", affiliate, saleUrl);
    assert.equal(product.oldPrice?.formatted, expected);
    assert.equal(product.amazon.referencePriceType, expected ? "LIST_PRICE" : undefined);
    assert.equal(product.amazon.savings, undefined);
  }
});

test("Creators current price rejects malformed money and missing currency", () => {
  for (const money of [
    { amount: Number.NaN, currency: "USD", displayAmount: "$24.99" },
    { amount: 24.99, displayAmount: "$24.99" },
    { amount: 24.99, currency: "US", displayAmount: "$24.99" },
    { amount: 24.99, currency: "USD", displayAmount: "" }
  ]) {
    assert.throws(() => mapCreatorsItem(creatorsItem({ offersV2: { listings: [creatorsListing({ price: { money } })] } }), "B08HNBHSQV", affiliate, saleUrl), { code: "AMAZON_NO_PURCHASABLE_OFFER" });
  }
});

test("Creators retains explicit savings fields and does not synthesize absent savings", () => {
  const withSavings = mapCreatorsItem(creatorsItem({ offersV2: { listings: [creatorsListing({ price: {
    money: { amount: 24.99, currency: "USD", displayAmount: "$24.99" },
    savingBasis: { money: { amount: 39.99, currency: "USD", displayAmount: "$39.99" }, savingBasisType: "LIST_PRICE", savingBasisTypeLabel: "List Price" },
    savings: { money: { amount: 15, currency: "USD", displayAmount: "$15.00" }, percentage: 38 }
  } })] } }), "B08HNBHSQV", affiliate, saleUrl);
  assert.deepEqual(withSavings.amazon.savings, {
    money: { value: 15, formatted: "$15.00", currency: "USD" },
    percentage: 38
  });
  const withoutSavings = mapCreatorsItem(creatorsItem(), "B08HNBHSQV", affiliate, saleUrl);
  assert.equal(withoutSavings.amazon.savings, undefined);
});

test("Creators rejects inconsistent savings amount or percentage without dropping valid prices", () => {
  for (const savings of [
    { money: { amount: 14, currency: "USD", displayAmount: "$14.00" }, percentage: 38 },
    { money: { amount: 15, currency: "USD", displayAmount: "$15.00" }, percentage: 20 },
    { money: { amount: 15, currency: "CAD", displayAmount: "CA$15.00" }, percentage: 38 },
    { money: { amount: 15, currency: "USD", displayAmount: "$15.00" } }
  ]) {
    const product = mapCreatorsItem(creatorsItem({ offersV2: { listings: [creatorsListing({ price: {
      money: { amount: 24.99, currency: "USD", displayAmount: "$24.99" },
      savingBasis: { money: { amount: 39.99, currency: "USD", displayAmount: "$39.99" }, savingBasisType: "LIST_PRICE" },
      savings
    } })] } }), "B08HNBHSQV", affiliate, saleUrl);
    assert.equal(product.currentPrice.formatted, "$24.99");
    assert.equal(product.oldPrice.formatted, "$39.99");
    assert.equal(product.amazon.savings, undefined);
  }
});

test("Creators never uses pricePerUnit as the current product price", () => {
  const price = { pricePerUnit: { amount: 4.17, currency: "USD", displayAmount: "$4.17 / Count" } };
  assert.throws(() => mapCreatorsItem(creatorsItem({ offersV2: { listings: [creatorsListing({ price })] } }), "B08HNBHSQV", affiliate, saleUrl), { code: "AMAZON_NO_PURCHASABLE_OFFER" });
});

test("Creators ignores coupon and promotion metadata when selecting current price", () => {
  const listing = creatorsListing({
    price: {
      money: { amount: 24.99, currency: "USD", displayAmount: "$24.99" },
      coupon: { percentage: 20, calculatedPrice: 19.99 },
      promotion: { amount: 5, calculatedPrice: 19.99 }
    }
  });
  const product = mapCreatorsItem(creatorsItem({ offersV2: { listings: [listing] } }), "B08HNBHSQV", affiliate, saleUrl);
  assert.equal(product.currentPrice.formatted, "$24.99");
  assert.equal(product.oldPrice, undefined);
  assert.equal(product.amazon.savings, undefined);
});

test("Creators LIST_PRICE retains card metadata while Facebook post omits all reference prices", () => {
  const price = {
    money: { amount: 24.99, currency: "USD", displayAmount: "$24.99" },
    savingBasis: { money: { amount: 39.99, currency: "USD", displayAmount: "$39.99" }, savingBasisType: "LIST_PRICE" },
    savings: { money: { amount: 15, currency: "USD", displayAmount: "$15.00" }, percentage: 38 }
  };
  const listPrice = mapCreatorsItem(creatorsItem({ offersV2: { listings: [creatorsListing({ price })] } }), "B08HNBHSQV", affiliate, saleUrl);
  assert.equal(listPrice.oldPrice.formatted, "$39.99");
  assert.equal(listPrice.amazon.referencePriceType, "LIST_PRICE");
  assert.equal(listPrice.amazon.savings.percentage, 38);
  const listPost = buildFacebookPost(listPrice, "ESR Magnetic Car Charger");
  assert.match(listPost, /\$24\.99/);
  assert.doesNotMatch(listPost, /#Ad|\$39\.99|list price|\bwas\b|https?:\/\//i);
  assert.ok(buildFacebookComment(listPrice).endsWith(affiliate));

  const wasPrice = mapCreatorsItem(creatorsItem({ offersV2: { listings: [creatorsListing({ price: {
    ...price, savingBasis: { ...price.savingBasis, savingBasisType: "WAS_PRICE" }
  } })] } }), "B08HNBHSQV", affiliate, saleUrl);
  assert.equal(wasPrice.oldPrice, undefined);
  assert.equal(wasPrice.amazon.referencePriceType, undefined);
  assert.equal(wasPrice.amazon.savings, undefined);
  assert.doesNotMatch(buildFacebookPost(wasPrice, "ESR Magnetic Car Charger"), /#Ad|\$39\.99|list price|\bwas\b|https?:\/\//i);
});

test("Amazon Facebook post uses current price only and keeps affiliate URL in comment", () => {
  const currentOnly = mapCreatorsItem(creatorsItem(), "B08HNBHSQV", affiliate, saleUrl);
  const currentCopy = buildFacebookPost(currentOnly, "ESR Magnetic Car Charger");
  assert.match(currentCopy, /\$24\.99/);
  assert.doesNotMatch(currentCopy, /#Ad|https?:\/\//i);
  const untypedReference = { ...currentOnly, oldPrice: { value: 39.99, formatted: "$39.99", currency: "USD" } };
  const copy = buildFacebookPost(untypedReference, "ESR Magnetic Car Charger");
  assert.doesNotMatch(copy, /\$39\.99|\bwas\b|list price|#Ad|https?:\/\//i);
  assert.equal(buildFacebookComment(currentOnly), `#Ad\n\nComment “Deal” 👇❤️\nSo you don’t miss any of our latest finds! 🎉\n✔️See it here: 👉 ${affiliate}`);
});

test("Creators reference price is omitted when not higher, currency differs, or semantics are unsupported", () => {
  for (const basis of [
    { money: { amount: 20, currency: "USD", displayAmount: "$20.00" }, savingBasisType: "LIST_PRICE" },
    { money: { amount: 39.99, currency: "CAD", displayAmount: "CA$39.99" }, savingBasisType: "LIST_PRICE" },
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

test("Creators preserves LIGHTNINGDEAL offer type without changing authoritative price", () => {
  const product = mapCreatorsItem(creatorsItem({ offersV2: { listings: [creatorsListing({
    type: "LIGHTNINGDEAL",
    price: { money: { amount: 21.99, currency: "USD", displayAmount: "$21.99" } }
  })] } }), "B08HNBHSQV", affiliate, saleUrl);
  assert.equal(product.currentPrice.formatted, "$21.99");
  assert.equal(product.amazon.listingType, "LIGHTNINGDEAL");
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

test("Amazon card renders authoritative current, LIST_PRICE, and validated Amazon savings", () => {
  const product = mapCreatorsItem(creatorsItem({ offersV2: { listings: [creatorsListing({ price: {
    money: { amount: 24.99, currency: "USD", displayAmount: "$24.99" },
    savingBasis: { money: { amount: 39.99, currency: "USD", displayAmount: "$39.99" }, savingBasisType: "LIST_PRICE" },
    savings: { money: { amount: 15, currency: "USD", displayAmount: "$15.00" }, percentage: 38 }
  } })] } }), "B08HNBHSQV", affiliate, saleUrl);
  const html = amazonCardHtml(product, { shortTitle: "ESR Magnetic Car Charger", facebookPost: "unused" }, "data:image/jpeg;base64,/9j/");
  assert.match(html, /Amazon Deal/);
  assert.match(html, /\$24\.99/);
  assert.match(html, /List price <\/span><span class="old-price">\$39\.99/);
  assert.match(html, /38% off/);
  assert.match(html, /data-card-ready/);
  assert.ok(!html.includes(affiliate));
  assert.ok(!/https?:\/\//.test(html.replace(/http-equiv=/g, "")));
});

test("Amazon card renders current-only and never calculates missing savings", () => {
  const currentOnly = mapCreatorsItem(creatorsItem(), "B08HNBHSQV", affiliate, saleUrl);
  const currentHtml = amazonCardHtml(currentOnly, { shortTitle: "ESR Magnetic Car Charger", facebookPost: "unused" }, "data:image/jpeg;base64,/9j/");
  assert.match(currentHtml, /\$24\.99/);
  assert.doesNotMatch(currentHtml, /List price|% off/);

  const listOnly = mapCreatorsItem(creatorsItem({ offersV2: { listings: [creatorsListing({ price: {
    money: { amount: 24.99, currency: "USD", displayAmount: "$24.99" },
    savingBasis: { money: { amount: 39.99, currency: "USD", displayAmount: "$39.99" }, savingBasisType: "LIST_PRICE" }
  } })] } }), "B08HNBHSQV", affiliate, saleUrl);
  const listHtml = amazonCardHtml(listOnly, { shortTitle: "ESR Magnetic Car Charger", facebookPost: "unused" }, "data:image/jpeg;base64,/9j/");
  assert.match(listHtml, /List price <\/span><span class="old-price">\$39\.99/);
  assert.doesNotMatch(listHtml, /% off/);
});

test("Amazon card omits rejected reference and inconsistent savings", () => {
  const product = mapCreatorsItem(creatorsItem({ offersV2: { listings: [creatorsListing({ price: {
    money: { amount: 24.99, currency: "USD", displayAmount: "$24.99" },
    savingBasis: { money: { amount: 39.99, currency: "USD", displayAmount: "$39.99" }, savingBasisType: "WAS_PRICE" },
    savings: { money: { amount: 14, currency: "USD", displayAmount: "$14.00" }, percentage: 20 }
  } })] } }), "B08HNBHSQV", affiliate, saleUrl);
  const html = amazonCardHtml(product, { shortTitle: "ESR Magnetic Car Charger", facebookPost: "unused" }, "data:image/jpeg;base64,/9j/");
  assert.match(html, /\$24\.99/);
  assert.doesNotMatch(html, /\$39\.99|List price|% off|\bwas\b/i);
});

test("Amazon Creators orchestration preserves exact affiliate URL, isolates AI, and disables card cache", async () => {
  const seen = [];
  let renders = 0;
  let cacheCalls = 0;
  let sovrnCalls = 0;
  const image = new Uint8Array([255, 216, 255, 217]);
  const responses = [new Response("resolution only", { headers: { "content-type": "text/html" } }), new Response(image, { headers: { "content-type": "image/jpeg" } })];
  const result = await processProductLink(affiliate, {
    fetcher: async (url) => { seen.push(url); return responses.shift(); }, dnsCheck: async () => {},
    copyProvider: { generate: async (rawTitle, correctionReason) => {
      assert.equal(rawTitle, "ESR HaloLock Magnetic Wireless Car Charger");
      assert.equal(correctionReason, undefined);
      for (const forbidden of [affiliate, "$24.99", "$39.99", "38", "B08HNBHSQV", "#Ad", "LIST_PRICE"]) assert.ok(!rawTitle.includes(forbidden));
      return { shortTitle: "ESR Magnetic Car Charger" };
    } },
    renderer: { screenshot: async html => { renders++; assert.match(html, /Amazon Deal/); assert.match(html, /List price/); assert.match(html, /38% off/); return { bytes: new Uint8Array([137,80,78,71,13,10,26,10]), mimeType: "image/png" }; } },
    amazonProductProvider: creatorsProvider(creatorsItem({ offersV2: { listings: [creatorsListing({ price: {
      money: { amount: 24.99, currency: "USD", displayAmount: "$24.99" },
      savingBasis: { money: { amount: 39.99, currency: "USD", displayAmount: "$39.99" }, savingBasisType: "LIST_PRICE" },
      savings: { money: { amount: 15, currency: "USD", displayAmount: "$15.00" }, percentage: 38 }
    } })] } })),
    sovrnProductProvider: { product: async () => { sovrnCalls++; throw new Error("Amazon must never invoke Sovrn"); } },
    cardCache: { lookup: async () => { cacheCalls++; throw Error("must not read"); }, claim: async () => { cacheCalls++; return null; }, store: async () => { cacheCalls++; }, release: async () => { cacheCalls++; } },
    disclosure: "#Ad", requestId: "amazon-process"
  });
  assert.equal(renders, 1);
  assert.equal(cacheCalls, 0);
  assert.equal(sovrnCalls, 0);
  assert.equal(result.product.postUrl, affiliate);
  assert.match(result.content.facebookPost, /\$24\.99/);
  assert.doesNotMatch(result.content.facebookPost, /#Ad|\$39\.99|38%|list price|https?:\/\//i);
  assert.ok(result.content.facebookComment.endsWith(affiliate));
});

test("Amazon short and multi-hop tracking links route by final destination and preserve exact postUrl", async () => {
  const cases = [
    { input: "https://link.amazon/B019JQ4Xw", chain: ["https://www.amazon.com/dp/B08HNBHSQV"] },
    { input: "https://joylink.io/amazon/amd-ryzen-9-32thread-processor", chain: ["https://tracker.example.net/click/abc", "https://www.amazon.com/gp/product/B08HNBHSQV"] },
    { input: shortAffiliate, chain: ["https://www.amazon.com/dp/B08HNBHSQV"] }
  ];
  for (const current of cases) {
    const image = new Uint8Array([255,216,255,217]);
    const destinations = [...current.chain];
    let providerAsin;
    const result = await processProductLink(current.input, {
      fetcher: async url => {
        if (url === current.input || current.chain.slice(0, -1).includes(url)) {
          const location = destinations.shift();
          return new Response(null, { status: 302, headers: { location } });
        }
        if (url === current.chain.at(-1)) return new Response("<html></html>", { headers: { "content-type": "text/html" } });
        if (url.startsWith("https://m.media-amazon.com/")) return new Response(image, { headers: { "content-type": "image/jpeg" } });
        throw new Error(`Unexpected fetch host: ${new URL(url).hostname}`);
      },
      dnsCheck: async () => {},
      copyProvider: { generate: async () => ({ shortTitle: "ESR Magnetic Car Charger" }) },
      renderer: { screenshot: async () => ({ bytes: new Uint8Array([137,80,78,71,13,10,26,10]), mimeType: "image/png" }) },
      amazonProductProvider: { product: async (asin, inputUrl, resolvedUrl) => {
        providerAsin = asin;
        return mapCreatorsItem(creatorsItem(), asin, inputUrl, resolvedUrl);
      } },
      disclosure: "#Ad", requestId: "amazon-tracker"
    });
    assert.equal(providerAsin, "B08HNBHSQV");
    assert.equal(result.product.store, "amazon");
    assert.equal(result.product.postUrl, current.input);
    assert.ok(!result.content.facebookPost.includes(current.input));
    assert.ok(result.content.facebookComment.endsWith(current.input));
  }
});

test("Amazon orchestration carries a followed intermediate ASIN through a final CLP route", async () => {
  const tracker = "https://joylink.io/amazon/256-gb-flash-drive";
  const asin = "B0D3PNRCMT";
  const dp = `https://www.amazon.com/dp/${asin}/ref=tracker`;
  const clp = "https://www.amazon.com/clp/opaque";
  const image = new Uint8Array([255,216,255,217]);
  let providerAsin;
  const result = await processProductLink(tracker, {
    fetcher: async url => {
      if (url === tracker) return new Response(null, { status: 302, headers: { location: dp } });
      if (url === dp) return new Response(null, { status: 301, headers: { location: clp } });
      if (url === clp) return new Response("<html><title>Product</title></html>", { headers: { "content-type": "text/html" } });
      if (url.startsWith("https://m.media-amazon.com/")) return new Response(image, { headers: { "content-type": "image/jpeg" } });
      throw new Error(`Unexpected fetch host: ${new URL(url).hostname}`);
    },
    dnsCheck: async () => {},
    copyProvider: { generate: async () => ({ shortTitle: "Portable Flash Drive" }) },
    renderer: { screenshot: async () => ({ bytes: new Uint8Array([137,80,78,71,13,10,26,10]), mimeType: "image/png" }) },
    amazonProductProvider: { product: async (requestedAsin, inputUrl, resolvedUrl) => {
      providerAsin = requestedAsin;
      return mapCreatorsItem(creatorsItem({ asin, itemInfo: { title: { displayValue: "Portable Flash Drive" } } }), requestedAsin, inputUrl, resolvedUrl);
    } },
    disclosure: "#Ad",
    requestId: "amazon-intermediate-route"
  });
  assert.equal(providerAsin, asin);
  assert.equal(result.product.resolvedUrl, clp);
  assert.equal(result.product.postUrl, tracker);
  assert.ok(result.content.facebookComment.endsWith(tracker));
});

test("Amazon CLP redirect retains original ASIN and exact postUrl through Creators verification", async () => {
  const image = new Uint8Array([255,216,255,217]);
  const clpUrl = "https://www.amazon.com/clp/B08HNBHSQV";
  const responses = [
    new Response(null, { status: 302, headers: { location: clpUrl } }),
    new Response("<html><title>Primary product</title></html>", { headers: { "content-type": "text/html" } }),
    new Response(image, { headers: { "content-type": "image/jpeg" } })
  ];
  let providerAsin;
  const result = await processProductLink(affiliate, {
    fetcher: async () => responses.shift(), dnsCheck: async () => {},
    copyProvider: { generate: async () => ({ shortTitle: "ESR Magnetic Car Charger" }) },
    renderer: { screenshot: async () => ({ bytes: new Uint8Array([137,80,78,71,13,10,26,10]), mimeType: "image/png" }) },
    amazonProductProvider: { product: async (asin, inputUrl, resolvedUrl) => {
      providerAsin = asin;
      return mapCreatorsItem(creatorsItem(), asin, inputUrl, resolvedUrl);
    } },
    disclosure: "#Ad", requestId: "amazon-clp"
  });
  assert.equal(providerAsin, "B08HNBHSQV");
  assert.equal(result.product.resolvedUrl, clpUrl);
  assert.equal(result.product.postUrl, affiliate);
  assert.ok(!result.content.facebookPost.includes(affiliate));
  assert.ok(result.content.facebookComment.endsWith(affiliate));
});

test("Amazon CLP flow rejects a mismatched Creators ASIN and supported-route redirect before API", async () => {
  const clpResponses = [
    new Response(null, { status: 302, headers: { location: "https://www.amazon.com/clp/B08HNBHSQV" } }),
    new Response("<html></html>", { headers: { "content-type": "text/html" } })
  ];
  await assert.rejects(processProductLink(affiliate, {
    fetcher: async () => clpResponses.shift(), dnsCheck: async () => {},
    copyProvider: { generate: async () => ({ shortTitle: "unused" }) }, renderer: { screenshot: async () => { throw Error("must not render"); } },
    amazonProductProvider: creatorsProvider(creatorsItem({ asin: "B00MNV8E0C" })), disclosure: "#Ad", requestId: "amazon-clp-api-mismatch"
  }), { code: "AMAZON_ASIN_MISMATCH" });

  let providerCalls = 0;
  const routeResponses = [
    new Response(null, { status: 302, headers: { location: "https://www.amazon.com/dp/B00MNV8E0C" } }),
    new Response("<html></html>", { headers: { "content-type": "text/html" } })
  ];
  await assert.rejects(processProductLink(affiliate, {
    fetcher: async () => routeResponses.shift(), dnsCheck: async () => {},
    copyProvider: { generate: async () => ({ shortTitle: "unused" }) }, renderer: { screenshot: async () => { throw Error("must not render"); } },
    amazonProductProvider: { product: async () => { providerCalls++; throw Error("must not call API"); } }, disclosure: "#Ad", requestId: "amazon-route-mismatch"
  }), { code: "AMAZON_ASIN_MISMATCH" });
  assert.equal(providerCalls, 0);
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
