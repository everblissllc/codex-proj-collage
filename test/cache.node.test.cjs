const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const src = path => require(join(process.env.COMPILED_ROOT, path));
const { productStateCacheKey, CARD_CACHE_VERSION, WALMART_TEMPLATE_VERSION, TITLE_GENERATION_VERSION } = src("cache/cache-key.js");
const { D1R2CardCache, cardCacheTtlSeconds, CARD_CACHE_LEASE_MS } = src("cache/card-cache.js");
const { processProductLink } = src("orchestration/process-product-link.js");
const { extractWalmartProduct } = src("stores/walmart/extractor.js");
const { BrowserScreenshotRenderer } = src("rendering/browser-renderer.js");

const pageUrl = "https://www.walmart.com/ip/123";
const affiliateA = "https://affiliate.example.org/go?tracking=ALPHA_SECRET";
const affiliateB = "https://affiliate.example.org/go?tracking=BETA_SECRET";
const fixture = readFileSync("test/fixtures/walmart-with-was.html", "utf8");
const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

class FakeD1 {
  rows = new Map();
  failRead = false;
  failClaim = false;
  failReadyWrite = false;
  prepare(query) {
    return { bind: (...args) => ({
      first: async () => {
        if (this.failRead) throw Error("D1 read failed");
        return this.rows.get(args[0]) ?? null;
      },
      run: async () => {
        const now = Date.now();
        if (query.includes("INSERT INTO card_cache")) {
          if (this.failClaim) throw Error("D1 claim failed");
          const [key, store, productId, created, updated, leaseUntil, token, staleAt, expiredAt, corruptUpdatedAt, corruptR2Key, isCorrupt] = args;
          const old = this.rows.get(key);
          const canClaim = !old || (old.status === "building" && old.lease_until <= staleAt) ||
            (old.status === "ready" && (old.expires_at <= expiredAt || (isCorrupt === 1 && old.updated_at === corruptUpdatedAt && old.r2_key === corruptR2Key)));
          if (!canClaim) return { meta: { changes: 0 } };
          this.rows.set(key, { cache_key: key, store, product_id: productId, status: "building", short_title: null,
            r2_key: null, mime_type: null, created_at: created, updated_at: updated, expires_at: null,
            last_accessed_at: null, hit_count: 0, lease_until: leaseUntil, builder_token: token });
          return { meta: { changes: 1 } };
        }
        if (query.includes("SET status = 'ready'")) {
          if (this.failReadyWrite) throw Error("D1 ready write failed");
          const [shortTitle, r2Key, created, updated, expires, key, token] = args;
          const row = this.rows.get(key);
          if (!row || row.status !== "building" || row.builder_token !== token) return { meta: { changes: 0 } };
          Object.assign(row, { status: "ready", short_title: shortTitle, r2_key: r2Key, mime_type: "image/png",
            created_at: created, updated_at: updated, expires_at: expires, lease_until: null, builder_token: null });
          return { meta: { changes: 1 } };
        }
        if (query.includes("SET hit_count = hit_count + 1")) {
          const [accessed, key, r2Key] = args;
          const row = this.rows.get(key);
          if (row?.status === "ready" && row.r2_key === r2Key) { row.hit_count++; row.last_accessed_at = accessed; return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        }
        if (query.includes("DELETE FROM card_cache")) {
          const [key, token] = args;
          const row = this.rows.get(key);
          if (row?.status === "building" && row.builder_token === token) { this.rows.delete(key); return { meta: { changes: 1 } }; }
          return { meta: { changes: 0 } };
        }
        throw Error(`Unexpected fake D1 query: ${query}`);
      }
    }) };
  }
}

class FakeR2 {
  objects = new Map();
  failGet = false;
  failPut = false;
  async get(key) {
    if (this.failGet) throw Error("R2 read failed");
    const object = this.objects.get(key);
    if (!object) return null;
    return { size: object.bytes.length, httpMetadata: { contentType: object.contentType },
      body: { cancel: async () => {} }, arrayBuffer: async () => object.bytes.slice().buffer };
  }
  async put(key, bytes, options) {
    if (this.failPut) throw Error("R2 write failed");
    this.objects.set(key, { bytes: Uint8Array.from(bytes), contentType: options.httpMetadata.contentType });
    return { key };
  }
}

async function captureLogs(work) {
  const old = [console.log, console.warn, console.error];
  const logs = [];
  console.log = console.warn = console.error = line => logs.push(JSON.parse(line));
  try { return { value: await work(), logs }; }
  finally { [console.log, console.warn, console.error] = old; }
}

function harness(options = {}) {
  const db = options.db ?? new FakeD1();
  const bucket = options.bucket ?? new FakeR2();
  const cache = new D1R2CardCache(db, bucket, 86_400);
  const counts = { page: 0, image: 0, ai: 0, browser: 0 };
  let html = fixture;
  let aiDelayMs = 0;
  let aiFails = false;
  const fetcher = async url => {
    const address = String(url);
    if (address === affiliateA || address === affiliateB) return new Response(null, { status: 302, headers: { location: pageUrl } });
    if (address === pageUrl) { counts.page++; return new Response(html, { headers: { "content-type": "text/html" } }); }
    if (address.includes("walmartimages.com")) { counts.image++; return new Response(png, { headers: { "content-type": "image/png" } }); }
    throw Error("Unexpected fetch");
  };
  const provider = { generate: async () => {
    counts.ai++;
    if (aiFails) throw Error("AI unavailable");
    if (aiDelayMs) await new Promise(resolve => setTimeout(resolve, aiDelayMs));
    return { shortTitle: "Disney Toniebox Starter Set" };
  } };
  const renderer = new BrowserScreenshotRenderer({ quickAction: async () => { counts.browser++; return new Response(png); } });
  const run = (url = affiliateA, useCache = true) => processProductLink(url, {
    fetcher, copyProvider: provider, renderer, disclosure: "#Ad", requestId: crypto.randomUUID(),
    dnsCheck: async () => {}, cardCache: useCache ? cache : undefined
  });
  return { db, bucket, cache, counts, run, setHtml: value => { html = value; }, setAiDelay: value => { aiDelayMs = value; }, setAiFails: value => { aiFails = value; } };
}

test("cache bindings absent retain the original uncached pipeline", async () => {
  const h = harness();
  const { value, logs } = await captureLogs(() => h.run(affiliateA, false));
  assert.deepEqual(h.counts, { page: 1, image: 1, ai: 1, browser: 1 });
  assert.equal(value.content.facebookComment.endsWith(affiliateA), true);
  assert.equal(logs.find(log => log.event === "card_cache_disabled").reason, "CACHE_BINDINGS_MISSING");
  assert.equal(h.db.rows.size, 0);
});

test("two unrelated Walmart pages without canonical IDs never touch or share cache storage", async () => {
  const pageA = "https://www.walmart.com/product/one";
  const pageB = "https://www.walmart.com/product/two";
  const imageUrl = "https://i5.walmartimages.com/seo/no-id.jpg";
  const html = `<script type="application/ld+json">${JSON.stringify({
    "@context": "https://schema.org", "@type": "Product", name: "Unidentified Walmart Product",
    image: imageUrl, offers: { "@type": "Offer", price: "59.00", priceCurrency: "USD" }
  })}</script>`;
  const counts = { page: 0, image: 0, ai: 0, browser: 0, cache: 0 };
  const failIfCached = () => { counts.cache++; throw Error("cache must remain disabled without a canonical product ID"); };
  const cardCache = { lookup: failIfCached, claim: failIfCached, store: failIfCached, release: failIfCached };
  const fetcher = async url => {
    if (url === affiliateA || url === affiliateB) return new Response(null, { status: 302, headers: { location: url === affiliateA ? pageA : pageB } });
    if (url === pageA || url === pageB) { counts.page++; return new Response(html, { headers: { "content-type": "text/html" } }); }
    if (url === imageUrl) { counts.image++; return new Response(png, { headers: { "content-type": "image/png" } }); }
    throw Error("Unexpected fetch in no-ID test");
  };
  const deps = {
    fetcher, dnsCheck: async () => {}, cardCache, disclosure: "#Ad", requestId: "missing-product-id-test",
    copyProvider: { generate: async () => { counts.ai++; return { shortTitle: "Unidentified Walmart Product" }; } },
    renderer: new BrowserScreenshotRenderer({ quickAction: async () => { counts.browser++; return new Response(png); } })
  };
  const { value: results, logs } = await captureLogs(async () => [
    await processProductLink(affiliateA, deps),
    await processProductLink(affiliateB, deps)
  ]);
  assert.deepEqual(counts, { page: 2, image: 2, ai: 2, browser: 2, cache: 0 });
  assert.equal(results[0].product.canonicalProductUrl, undefined);
  assert.equal(results[1].product.canonicalProductUrl, undefined);
  assert.equal(results[0].content.facebookComment.endsWith(affiliateA), true);
  assert.equal(results[1].content.facebookComment.endsWith(affiliateB), true);
  assert.deepEqual(logs.filter(log => log.event === "card_cache_disabled").map(log => log.reason), ["CACHE_PRODUCT_ID_UNAVAILABLE", "CACHE_PRODUCT_ID_UNAVAILABLE"]);
  assert.equal(logs.some(log => log.event === "card_cache_lookup" || log.event === "card_cache_stored"), false);
  assert.ok(!JSON.stringify(logs).includes(affiliateA));
  assert.ok(!JSON.stringify(logs).includes(affiliateB));
});

test("cache key rejects missing or weak Walmart product IDs", async () => {
  const product = extractWalmartProduct(fixture, affiliateA, pageUrl);
  for (const productId of ["", "undefined", "null", "www.walmart.com", "https://affiliate.example.org/go", "0"]) {
    await assert.rejects(productStateCacheKey(product, productId), /Canonical Walmart product ID unavailable/);
  }
});

test("first miss stores title and PNG; fresh extraction on second affiliate link hits cache", async () => {
  const h = harness();
  const { value: results, logs } = await captureLogs(async () => [await h.run(affiliateA), await h.run(affiliateB)]);
  assert.deepEqual(h.counts, { page: 2, image: 1, ai: 1, browser: 1 });
  assert.deepEqual(results[0].card.bytes, results[1].card.bytes);
  assert.equal(results[0].content.shortTitle, results[1].content.shortTitle);
  assert.equal(results[0].content.facebookComment.endsWith(affiliateA), true);
  assert.equal(results[1].content.facebookComment.endsWith(affiliateB), true);
  assert.ok(!results[1].content.facebookComment.includes(affiliateA));
  assert.equal(logs.filter(log => log.event === "card_cache_stored").length, 1);
  assert.equal(logs.filter(log => log.event === "card_cache_hit").length, 1);
  assert.equal(h.db.rows.size, 1);
  assert.equal(h.bucket.objects.size, 1);
  const persisted = JSON.stringify([...h.db.rows.values(), ...h.bucket.objects.keys(), logs]);
  assert.ok(!persisted.includes(affiliateA));
  assert.ok(!persisted.includes(affiliateB));
  assert.ok(!persisted.includes("data:image"));
  assert.ok(!persisted.includes("ALPHA_SECRET"));
  assert.ok(!persisted.includes("BETA_SECRET"));
});

test("price, old price, title, image identity, and version changes all miss", async () => {
  const product = extractWalmartProduct(fixture, affiliateA, pageUrl);
  const first = await productStateCacheKey(product, "123");
  const secondAffiliate = await productStateCacheKey({ ...product, inputUrl: affiliateB, postUrl: affiliateB }, "123");
  assert.equal(first.key, secondAffiliate.key);
  assert.match(first.key, /^[a-f0-9]{64}$/);
  assert.ok(!JSON.stringify(first).includes(affiliateA));
  const variants = [
    { ...product, currentPrice: { ...product.currentPrice, value: 17, formatted: "$17.00" } },
    { ...product, oldPrice: undefined },
    { ...product, oldPrice: { ...product.oldPrice, value: 39.99, formatted: "$39.99" } },
    { ...product, rawTitle: `${product.rawTitle} updated` },
    { ...product, imageUrl: `${product.imageUrl}?version=2` }
  ];
  for (const variant of variants) assert.notEqual((await productStateCacheKey(variant, "123")).key, first.key);
  for (const versions of [
    { cache: "v2", template: WALMART_TEMPLATE_VERSION, title: TITLE_GENERATION_VERSION },
    { cache: CARD_CACHE_VERSION, template: "walmart-v2", title: TITLE_GENERATION_VERSION },
    { cache: CARD_CACHE_VERSION, template: WALMART_TEMPLATE_VERSION, title: "title-v2" }
  ]) assert.notEqual((await productStateCacheKey(product, "123", versions)).key, first.key);
});

test("changed authoritative current or old price rebuilds a card", async () => {
  const h = harness();
  await captureLogs(async () => {
    await h.run();
    h.setHtml(fixture.replace('"price":"59.00"', '"price":"17.00"'));
    const currentChanged = await h.run();
    assert.ok(currentChanged.content.facebookPost.includes("$17.00"));
    h.setHtml(fixture.replace('"wasPrice":"99.00"', '"wasPrice":"79.99"'));
    const oldChanged = await h.run();
    assert.ok(!oldChanged.content.facebookPost.includes("$79.99"));
  });
  assert.deepEqual(h.counts, { page: 3, image: 3, ai: 3, browser: 3 });
});

test("expired, missing, and invalid R2 cards are misses and rebuild", async () => {
  const h = harness();
  const { logs } = await captureLogs(async () => {
    await h.run();
    const row = [...h.db.rows.values()][0];
    row.expires_at = Date.now() - 1;
    await h.run();
    h.bucket.objects.delete([...h.db.rows.values()][0].r2_key);
    await h.run();
    const newest = [...h.db.rows.values()][0];
    h.bucket.objects.get(newest.r2_key).bytes = new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]);
    await h.run();
  });
  assert.deepEqual(h.counts, { page: 4, image: 4, ai: 4, browser: 4 });
  assert.equal(logs.filter(log => log.event === "card_cache_corrupt").length, 2);
});

test("wrong R2 MIME and oversized cached PNG are rejected before Telegram delivery", async () => {
  const h = harness();
  await captureLogs(async () => {
    await h.run();
    let object = h.bucket.objects.get([...h.db.rows.values()][0].r2_key);
    object.contentType = "image/jpeg";
    await h.run();
    object = h.bucket.objects.get([...h.db.rows.values()][0].r2_key);
    object.bytes = new Uint8Array(10_000_001);
    await h.run();
  });
  assert.deepEqual(h.counts, { page: 3, image: 3, ai: 3, browser: 3 });
});

test("D1 or R2 read failure fails open to the original build", async () => {
  const h = harness();
  const { logs } = await captureLogs(async () => {
    await h.run();
    h.db.failRead = true;
    await h.run();
    h.db.failRead = false;
    h.bucket.failGet = true;
    await h.run();
  });
  assert.deepEqual(h.counts, { page: 3, image: 3, ai: 3, browser: 3 });
  assert.equal(logs.filter(log => log.event === "card_cache_read_failed").length, 2);
});

test("D1 claim failure fails open without losing a successful card", async () => {
  const h = harness();
  h.db.failClaim = true;
  const { value, logs } = await captureLogs(() => h.run());
  assert.equal(value.card.mimeType, "image/png");
  assert.deepEqual(h.counts, { page: 1, image: 1, ai: 1, browser: 1 });
  assert.equal(logs.find(log => log.event === "card_cache_write_failed").errorCode, "CACHE_CLAIM_FAILED");
});

test("R2 and D1 write failures after rendering do not withhold the card", async () => {
  const r2Failure = harness();
  r2Failure.bucket.failPut = true;
  const r2 = await captureLogs(() => r2Failure.run());
  assert.equal(r2.value.card.mimeType, "image/png");
  assert.equal(r2Failure.db.rows.size, 0);
  assert.equal(r2.logs.find(log => log.event === "card_cache_write_failed").errorCode, "CACHE_STORE_FAILED");
  const d1Failure = harness();
  d1Failure.db.failReadyWrite = true;
  const d1 = await captureLogs(() => d1Failure.run());
  assert.equal(d1.value.card.mimeType, "image/png");
  assert.equal(d1Failure.db.rows.size, 0);
  assert.equal(d1.logs.find(log => log.event === "card_cache_write_failed").errorCode, "CACHE_STORE_FAILED");
});

test("concurrent different affiliate links share one claimed card build", async () => {
  const h = harness();
  h.setAiDelay(100);
  const { value: results, logs } = await captureLogs(() => Promise.all([h.run(affiliateA), h.run(affiliateB)]));
  assert.deepEqual(h.counts, { page: 2, image: 1, ai: 1, browser: 1 });
  assert.equal(results[0].content.facebookComment.endsWith(affiliateA), true);
  assert.equal(results[1].content.facebookComment.endsWith(affiliateB), true);
  assert.equal(logs.filter(log => log.event === "card_cache_build_claimed").length, 1);
  assert.equal(logs.filter(log => log.event === "card_cache_build_wait").length >= 1, true);
  assert.equal(logs.filter(log => log.event === "card_cache_hit").length, 1);
});

test("stale build lease can be reclaimed atomically and wrong token cannot publish", async () => {
  const h = harness();
  const product = extractWalmartProduct(fixture, affiliateA, pageUrl);
  const identity = await productStateCacheKey(product, "123");
  const first = await h.cache.claim(identity);
  assert.ok(first);
  assert.equal(await h.cache.claim(identity), null);
  const row = h.db.rows.get(identity.key);
  assert.equal(row.lease_until - row.created_at, CARD_CACHE_LEASE_MS);
  row.lease_until = Date.now() - 1;
  const second = await h.cache.claim(identity);
  assert.ok(second);
  assert.notEqual(second, first);
  await assert.rejects(h.cache.store(identity, first, "Old builder", { bytes: png, mimeType: "image/png" }), /lease was lost/);
  await h.cache.store(identity, second, "New builder", { bytes: png, mimeType: "image/png" });
  assert.equal((await h.cache.lookup(identity, "lease-test")).shortTitle, "New builder");
});

test("failed AI build releases its own claim and preserves original failure", async () => {
  const h = harness();
  h.setAiFails(true);
  await captureLogs(async () => {
    await assert.rejects(h.run(), { code: "AI_PROVIDER_FAILED" });
  });
  assert.equal(h.db.rows.size, 0);
});

test("TTL is bounded and migration stores no affiliate or image data", () => {
  assert.equal(cardCacheTtlSeconds(), 86_400);
  assert.equal(cardCacheTtlSeconds("60"), 300);
  assert.equal(cardCacheTtlSeconds("999999"), 86_400);
  assert.equal(cardCacheTtlSeconds("bad"), 86_400);
  const sql = readFileSync("migrations/0001_card_cache.sql", "utf8");
  assert.match(sql, /cache_key TEXT PRIMARY KEY/);
  assert.match(sql, /CHECK \(status IN \('building', 'ready'\)\)/);
  assert.doesNotMatch(sql, /affiliate|input_url|post_url|telegram|image_bytes|facebook_post/i);
});

test("migration and atomic claim/store SQL execute in SQLite", async () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec(readFileSync("migrations/0001_card_cache.sql", "utf8"));
    const db = { prepare: query => ({ bind: (...values) => ({
      first: async () => sqlite.prepare(query).get(...values) ?? null,
      run: async () => ({ meta: { changes: Number(sqlite.prepare(query).run(...values).changes) } })
    }) }) };
    const cache = new D1R2CardCache(db, new FakeR2());
    const identity = await productStateCacheKey(extractWalmartProduct(fixture, affiliateA, pageUrl), "123");
    const first = await cache.claim(identity);
    assert.ok(first);
    assert.equal(await cache.claim(identity), null);
    await cache.store(identity, first, "Disney Toniebox Starter Set", { bytes: png, mimeType: "image/png" });
    assert.equal((await cache.lookup(identity, "sqlite-test")).kind, "hit");
    assert.equal(await cache.claim(identity), null);
    sqlite.prepare("UPDATE card_cache SET mime_type = 'image/jpeg' WHERE cache_key = ?").run(identity.key);
    const corrupt = await cache.lookup(identity, "sqlite-test");
    assert.equal(corrupt.kind, "corrupt");
    const replacement = await cache.claim(identity, { updatedAt: corrupt.updatedAt, r2Key: corrupt.r2Key });
    assert.ok(replacement);
    await cache.store(identity, replacement, "New Disney Toniebox", { bytes: png, mimeType: "image/png" });
    assert.equal(await cache.claim(identity, { updatedAt: corrupt.updatedAt, r2Key: corrupt.r2Key }), null);
    sqlite.prepare("UPDATE card_cache SET expires_at = ? WHERE cache_key = ?").run(Date.now() - 1, identity.key);
    assert.ok(await cache.claim(identity));
  } finally { sqlite.close(); }
});
