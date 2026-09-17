const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const root = process.env.COMPILED_ROOT;
const req = relative => require(path.join(root, relative));

const { ProductError } = req("types.js");
const { SovrnClient } = req("stores/sovrn/client.js");
const { sovrnStoreForHostname } = req("stores/sovrn/merchant-registry.js");
const { buildSovrnPlainlink } = req("stores/sovrn/plainlink.js");
const { mapSovrnProduct, buildSovrnFacebookPost } = req("stores/sovrn/product-mapper.js");
const { describeSovrnPriceResponse, describeSovrnResponse, inspectApprovedMerchants } = req("stores/sovrn/response-shape.js");
const { WorkersAICopyProvider } = req("ai/workers-ai-provider.js");

const config = { secretKey: "secret-value", siteApiKey: "site-value", market: "usd_en", campaignId: "123" };
const money = (value, currency = "USD") => ({ value, currency, formatted: `$${value.toFixed(2)}` });
const baseOffer = (overrides = {}) => ({
  merchantName: "Target", merchantDomain: "www.target.com", merchantGroupId: 77,
  identity: { merchantProductId: "12345678" }, title: "Real Product", imageUrl: "https://images.example.org/product.jpg",
  currentPrice: money(12.99), stockState: "in_stock", ...overrides
});
const map = (offers, overrides = {}) => mapSovrnProduct({
  store: "target", postUrl: "https://www.target.com/p/item/-/A-12345678?afid=original",
  resolvedUrl: "https://www.target.com/p/item/-/A-12345678", plainlink: "https://www.target.com/p/item/-/A-12345678",
  productIdentity: "12345678", offers, ...overrides
});
const expectCode = (fn, code) => assert.throws(fn, error => error instanceof ProductError && error.code === code);

test("Sovrn candidate domains use exact/subdomain matching and reject lookalikes", () => {
  const cases = [
    ["www.target.com", "target"], ["fake-target.com", undefined],
    ["shop.nordstrom.com", "nordstrom"], ["nordstrom.example.com", undefined],
    ["www.ulta.com", "ulta"], ["fakeulta.com", undefined],
    ["sephora.com", "sephora"], ["sephora.example.com", undefined],
    ["www.ecosmetics.com", "ecosmetics"], ["fakeecosmetics.com", undefined],
    ["hellobubble.com", "bubble"], ["fakehellobubble.com", undefined]
  ];
  for (const [host, expected] of cases) assert.equal(sovrnStoreForHostname(host), expected, host);
});

test("retailer plainlinks remove known tracking but preserve exact original and variant identity", () => {
  const original = "https://www.target.com/p/item/-/A-12345678?utm_source=x&preselect=7654321&afid=partner";
  const result = buildSovrnPlainlink(original, "target");
  assert.equal(original, "https://www.target.com/p/item/-/A-12345678?utm_source=x&preselect=7654321&afid=partner");
  assert.equal(result.plainlink, "https://www.target.com/p/item/-/A-12345678?preselect=7654321");
  assert.equal(result.productIdentity, "12345678");
  const sephora = buildSovrnPlainlink("https://www.sephora.com/product/name-P12345?skuId=9988&utm_medium=social", "sephora");
  assert.equal(sephora.plainlink, "https://www.sephora.com/product/name-P12345?skuId=9988");
  expectCode(() => buildSovrnPlainlink("https://evil.example.net/p/item/-/A-12345678", "target"), "SOVRN_MERCHANT_MISMATCH");
});

test("client uses official auth, market, plainlink and does not log credentials", async () => {
  let request;
  const logs = [];
  const oldLog = console.log;
  console.log = line => logs.push(String(line));
  try {
    const client = new SovrnClient(config, async (input, init) => {
      request = { input: String(input), init };
      return new Response('{"results":[]}', { status: 200, headers: { "content-type": "application/json" } });
    });
    await client.compareByPlainlink({ plainlink: "https://www.target.com/p/item/-/A-12345678", store: "target", requestId: "safe" });
  } finally { console.log = oldLog; }
  assert.match(request.input, /\/sites\/site-value\/compare\/prices\/usd_en\/by\/accuracy/);
  assert.equal(new URL(request.input).searchParams.get("plainlink"), "https://www.target.com/p/item/-/A-12345678");
  assert.equal(request.init.headers.authorization, "secret secret-value");
  const output = logs.join("\n");
  assert.doesNotMatch(output, /secret-value|site-value|Authorization/i);
});

test("client retries 429 once with bounded Retry-After and then succeeds", async () => {
  let calls = 0;
  const waits = [];
  const client = new SovrnClient(config, async () => {
    calls++;
    return calls === 1 ? new Response("", { status: 429, headers: { "retry-after": "99" } }) : Response.json({ results: [] });
  }, async ms => waits.push(ms));
  await client.compareByPlainlink({ plainlink: "https://www.target.com/p/item/-/A-12345678", store: "target" });
  assert.equal(calls, 2);
  assert.deepEqual(waits, [5000]);
});

test("client stops after two 429s and classifies timeout", async () => {
  let calls = 0;
  const throttled = new SovrnClient(config, async () => { calls++; return new Response("", { status: 429 }); }, async () => {});
  await assert.rejects(() => throttled.compareByPlainlink({ plainlink: "https://www.target.com/p/item/-/A-12345678", store: "target" }), error => error.code === "SOVRN_RATE_LIMITED");
  assert.equal(calls, 2);
  const timed = new SovrnClient(config, async () => { throw new Error("network secret-value site-value"); });
  await assert.rejects(() => timed.compareByPlainlink({ plainlink: "https://www.target.com/p/item/-/A-12345678", store: "target" }), error => error.code === "SOVRN_TIMEOUT");
});

test("source merchant is selected and cheaper alternative merchant is never substituted", () => {
  const result = map([baseOffer(), baseOffer({ merchantName: "Walmart", merchantDomain: "walmart.com", currentPrice: money(1) })]);
  assert.equal(result.product.currentPrice.value, 12.99);
  expectCode(() => map([baseOffer({ merchantName: "Walmart", merchantDomain: "walmart.com" })]), "SOVRN_MERCHANT_MISMATCH");
});

test("exact product mismatch and ambiguous source offers fail safely", () => {
  expectCode(() => map([baseOffer({ identity: { merchantProductId: "other" } })]), "SOVRN_PRODUCT_MISMATCH");
  expectCode(() => map([baseOffer(), baseOffer({ merchantGroupId: 78 })]), "SOVRN_AMBIGUOUS_OFFER");
});

test("current price and supported higher was reference are mapped", () => {
  const result = map([baseOffer({ referencePrice: money(19.99), referenceSemantics: "was" })]);
  assert.equal(result.product.currentPrice.value, 12.99);
  assert.equal(result.product.oldPrice.value, 19.99);
  assert.equal(result.referenceSemantics, "was");
  assert.equal(buildSovrnFacebookPost(result.product, "Short Product", "#Ad", result.referenceSemantics),
    "#Ad 🚨 Short Product is now $12.99, was $19.99.\n\n👉 https://www.target.com/p/item/-/A-12345678?afid=original");
});

test("list semantics are accurate and absent/invalid references produce current-only copy", () => {
  const listed = map([baseOffer({ referencePrice: money(20), referenceSemantics: "list" })]);
  assert.match(buildSovrnFacebookPost(listed.product, "Short Product", "#Ad", listed.referenceSemantics), /list price \$20\.00/);
  for (const reference of [undefined, money(10), money(20, "CAD")]) {
    const result = map([baseOffer({ referencePrice: reference, referenceSemantics: "was" })]);
    assert.equal(result.product.oldPrice, undefined);
    assert.equal(buildSovrnFacebookPost(result.product, "Short Product", "#Ad", result.referenceSemantics),
      "#Ad 🚨 Short Product is now $12.99.\n\n👉 https://www.target.com/p/item/-/A-12345678?afid=original");
  }
});

test("out-of-stock source is rejected and alternate in-stock merchant cannot replace it", () => {
  expectCode(() => map([
    baseOffer({ stockState: "out_of_stock" }),
    baseOffer({ merchantName: "Walmart", merchantDomain: "walmart.com", stockState: "in_stock" })
  ]), "SOVRN_OUT_OF_STOCK");
});

test("missing price and image fail; HTTPS public image is accepted", () => {
  expectCode(() => map([baseOffer({ currentPrice: undefined })]), "SOVRN_MISSING_PRICE");
  expectCode(() => map([baseOffer({ imageUrl: undefined })]), "SOVRN_MISSING_IMAGE");
  expectCode(() => map([baseOffer({ imageUrl: "http://localhost/image.jpg" })]), "SOVRN_MISSING_IMAGE");
  assert.equal(map([baseOffer()]).product.imageUrl, "https://images.example.org/product.jpg");
});

test("exact affiliate URL remains postUrl while lookup URL remains internal", () => {
  const original = "https://www.target.com/p/item/-/A-12345678?afid=a%2Bb&preselect=99";
  const result = map([baseOffer()], { postUrl: original });
  assert.equal(result.product.postUrl, original);
  assert.match(buildSovrnFacebookPost(result.product, "Short Product", "#Ad"), new RegExp(original.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$"));
  assert.doesNotMatch(buildSovrnFacebookPost(result.product, "Short Product", "#Ad"), /comparisons\.sovrn/);
});

test("Workers AI receives rawTitle only, without URL, price, or Sovrn metadata", async () => {
  let inference;
  const provider = new WorkersAICopyProvider({ run: async (_model, input) => {
    inference = input;
    return { response: '{"shortTitle":"Short Product"}' };
  } }, "@cf/test/model");
  const mapped = map([baseOffer({ title: "Only Trusted Raw Title" })]);
  await provider.generate(mapped.product);
  const userPayload = inference.messages.find(message => message.role === "user").content;
  assert.equal(userPayload, '{"rawTitle":"Only Trusted Raw Title"}');
  assert.doesNotMatch(JSON.stringify(inference), /target\.com|12\.99|12345678|site-value|secret-value/);
});

test("sanitized shape discovery emits keys/types/presence without product URL or secret values", () => {
  const raw = { products: [{ merchantName: "Target", title: "Visible Pilot Title", salePrice: 12.99, imageUrl: "https://secret.example/p.jpg", affiliateUrl: "https://tracked.example/?key=secret-value", stock: true }] };
  const summary = describeSovrnResponse(raw);
  assert.equal(summary.resultCount, 1);
  assert.equal(summary.offers[0].fieldTypes.salePrice, "number");
  assert.equal(summary.offers[0].presence.priceLike, true);
  const serialized = JSON.stringify(summary);
  assert.match(serialized, /Visible Pilot Title|secret\.example/);
  assert.doesNotMatch(serialized, /tracked\.example|secret-value/);
});

test("price response discovery exposes exact safe offer fields but never deeplink values", () => {
  const raw = [{
    merchant: { name: "Target", id: 390 }, name: "CeraVe Face Wash", id: 123,
    salePrice: 15.99, retailPrice: 17.99, currency: "USD", discountRate: 11,
    affiliatable: true, deeplink: "https://redirect.viglink.com/?secret=hidden",
    image: "https://target.scene7.com/item.jpg", thumbnail: "https://target.scene7.com/thumb.jpg",
    availability: "in stock", gtin: "0012345678905"
  }];
  const summary = describeSovrnPriceResponse(raw);
  assert.equal(summary.resultCount, 1);
  assert.deepEqual(summary.offers[0].merchant, { name: "Target", id: 390 });
  assert.equal(summary.offers[0].name, "CeraVe Face Wash");
  assert.equal(summary.offers[0].salePrice, 15.99);
  assert.equal(summary.offers[0].retailPrice, 17.99);
  assert.equal(summary.offers[0].deeplinkPresent, true);
  assert.deepEqual(summary.offers[0].image, { present: true, https: true, hostname: "target.scene7.com" });
  assert.equal(summary.offers[0].stockFields[0].value, "in stock");
  assert.equal(summary.offers[0].strongerIdentityFields[0].value, "0012345678905");
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /redirect\.viglink|secret=hidden|item\.jpg|thumb\.jpg/);
});

test("approved merchant discovery uses presence in the official collection without exposing raw rows", () => {
  const findings = inspectApprovedMerchants({ results: [
    { merchantGroupId: 77, merchantName: "Target", domains: ["target.com", "www.target.com"], approvalStatus: "ACTIVE", geo: "US" }
  ] }, ["target.com", "sephora.com"]);
  assert.deepEqual(findings.map(item => [item.domain, item.found, item.approved]), [
    ["target.com", true, true], ["sephora.com", false, false]
  ]);
  assert.equal(findings[0].groupId, 77);
  assert.ok(findings[0].statusFields.some(field => field.path.endsWith("approvalStatus")));
});

test("approved merchant request uses one filtered POST and requires campaign configuration", async () => {
  let request;
  const client = new SovrnClient(config, async (input, init) => { request = { input: String(input), init }; return Response.json({ results: [] }); });
  await client.approvedMerchants(["target.com", "sephora.com"], "merchant-check");
  assert.equal(new URL(request.input).hostname, "viglink.io");
  assert.equal(new URL(request.input).searchParams.get("campaignId"), "123");
  assert.equal(request.init.method, "POST");
  assert.deepEqual(JSON.parse(request.init.body).filters[0].values, ["target.com", "sephora.com"]);
  const missing = new SovrnClient({ ...config, campaignId: undefined }, async () => Response.json({}));
  await assert.rejects(() => missing.approvedMerchants(["target.com"]), error => error.code === "SOVRN_CONFIG_MISSING");
});
