const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const src = path => require(join(process.env.COMPILED_ROOT, path));
const { detectStore } = src('stores/detect-store.js');
const { extractBubbleProduct, inspectBubbleHtml, bubblePriceSelection, bubbleAdapter } = src('stores/screenshot/bubble.js');
const { BrowserMobilePageRenderer } = src('rendering/mobile-page-renderer.js');
const { processProductLink } = src('orchestration/process-product-link.js');
const { WorkersAICopyProvider } = src('ai/workers-ai-provider.js');
const { buildFacebookPost } = src('ai/build-facebook-post.js');
const html = readFileSync('test/fixtures/bubble-product.html', 'utf8');
const input = 'https://affiliate.example.org/click?merchant=Bubble&tag=User%2B42';
const resolved = 'https://hellobubble.com/products/water-slide';
const png = Uint8Array.from([137,80,78,71,13,10,26,10,1]);
const pricingHtml = ({oneTime, compareAt=null, subscription=null, coupon=''}) => `<!doctype html><html><head>
  <meta property="product:price:currency" content="USD">
  <script type="application/ld+json">${JSON.stringify({'@type':'Product',name:'Bubble Test Product',image:'https://cdn.shopify.com/product.png',url:resolved,offers:{'@type':'Offer',price:(oneTime/100).toFixed(2),priceCurrency:'USD'}})}</script>
  <script type="application/json">${JSON.stringify({id:1,title:'Bubble Test Product',handle:'water-slide',price:oneTime,compare_at_price:compareAt,featured_image:'//cdn.shopify.com/product.png',variants:[{id:11,title:'Default Title',available:true,price:oneTime,compare_at_price:compareAt,selling_plan_allocations:subscription===null?[]:[{price:subscription,compare_at_price:oneTime}]}]})}</script>
  </head><body><main id="MainContent"><section><img src="https://cdn.shopify.com/product.png"><h1>Bubble Test Product</h1><div class="price">$${(oneTime/100).toFixed(2)}</div><div>${coupon}</div><form action="/cart/add"><button type="submit">Add to cart</button></form></section></main></body></html>`;

test('Bubble exact-domain detection rejects lookalikes', () => {
  assert.equal(detectStore('https://hellobubble.com/products/water-slide'), 'bubble');
  assert.equal(detectStore('https://www.hellobubble.com/products/water-slide'), 'bubble');
  assert.equal(detectStore('https://fakehellobubble.com/products/water-slide'), undefined);
  assert.equal(detectStore('https://hellobubble.example.com/products/water-slide'), undefined);
});

test('Bubble extracts JSON-LD current price and genuine Shopify compare-at price', () => {
  const product = extractBubbleProduct(html, input, resolved);
  assert.equal(product.store, 'bubble');
  assert.equal(product.rawTitle, 'Water Slide Hydration Boosting Serum');
  assert.equal(product.imageUrl, 'https://cdn.shopify.com/files/water-slide.png');
  assert.equal(product.currentPrice.formatted, '$17.00');
  assert.equal(product.oldPrice.formatted, '$25.00');
  assert.equal(product.currentPrice.currency, 'USD');
  assert.equal(product.postUrl, input);
  assert.equal(product.canonicalProductUrl, resolved);
  assert.deepEqual(inspectBubbleHtml(html), {
    hasJsonLdProduct: true, hasEmbeddedProductState: true, hasProductMain: true,
    hasOgTitle: true, hasPriceOffer: true, hasPurchaseForm: true, challengeDetected: false
  });
});

test('Bubble ignores subscription selling-plan prices and omits absent old price', () => {
  const product = extractBubbleProduct(pricingHtml({oneTime:1700,subscription:1530}), input, resolved);
  assert.equal(product.currentPrice.formatted, '$17.00');
  assert.equal(product.oldPrice, undefined);
  assert.ok(!product.currentPrice.formatted.includes('15.30'));
});

test('Bubble embedded Shopify fallback uses one-time price rather than selling plan price', () => {
  const embeddedOnly = html.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/, '');
  const product = extractBubbleProduct(embeddedOnly, input, resolved);
  assert.equal(product.currentPrice.formatted, '$17.00');
  assert.equal(product.oldPrice.formatted, '$25.00');
});

test('Bubble one-time sale uses sale price as current and compare-at as old price', () => {
  const saleHtml=pricingHtml({oneTime:1299,compareAt:1900});
  const product=extractBubbleProduct(saleHtml,input,resolved);
  assert.equal(product.currentPrice.formatted,'$12.99');
  assert.equal(product.oldPrice.formatted,'$19.00');
  assert.equal(buildFacebookPost(product,'Bubble Test Product','#Ad'),`#Ad 🚨 Bubble Test Product is now $12.99, was $19.00.\n\n👉 ${input}`);
  assert.equal(bubblePriceSelection(saleHtml,resolved),'first_available_variant');
});

test('Bubble ordinary non-sale one-time price has no old price', () => {
  const product=extractBubbleProduct(pricingHtml({oneTime:1900}),input,resolved);
  assert.equal(product.currentPrice.formatted,'$19.00');
  assert.equal(product.oldPrice,undefined);
});

test('Bubble one-time sale remains authoritative over a separate subscription discount', () => {
  const product=extractBubbleProduct(pricingHtml({oneTime:1400,compareAt:1900,subscription:1190}),input,resolved);
  assert.equal(product.currentPrice.formatted,'$14.00');
  assert.equal(product.oldPrice.formatted,'$19.00');
});

test('Bubble subscription-only discount does not become the general current price', () => {
  const product=extractBubbleProduct(pricingHtml({oneTime:1900,subscription:1615}),input,resolved);
  assert.equal(product.currentPrice.formatted,'$19.00');
  assert.equal(product.oldPrice,undefined);
});

test('Bubble coupon text without authoritative final price is ignored', () => {
  const product=extractBubbleProduct(pricingHtml({oneTime:1900,coupon:'Use code SAVE for $12.99'}),input,resolved);
  assert.equal(product.currentPrice.formatted,'$19.00');
  assert.equal(product.oldPrice,undefined);
});

test('Bubble rejects malformed/missing current price and non-product pages', () => {
  const priced=pricingHtml({oneTime:1900});
  assert.throws(() => extractBubbleProduct(priced.replace(/"price":1900/g,'"price":"Call"').replace('"price":"19.00"','"price":"Call"'), input, resolved), { code: 'MISSING_PRICE' });
  assert.throws(() => extractBubbleProduct(priced.replace(/"price":1900/g,'"price":null').replace('"price":"19.00"','"price":null'), input, resolved), { code: 'MISSING_PRICE' });
  assert.throws(() => extractBubbleProduct('<html><main><h1>Our story</h1></main></html>', input, 'https://hellobubble.com/pages/about'), { code: 'NOT_PRODUCT_PAGE' });
});

test('Bubble adapter uses accepted mobile viewport and nonce-gated full product region', async () => {
  const calls = [];
  const renderer = new BrowserMobilePageRenderer({ quickAction: async (_action, options) => { calls.push(options); return new Response(png); } });
  const card = await renderer.screenshotProductPage(resolved, bubbleAdapter, 'bubble-render-test');
  assert.deepEqual(card.bytes, png);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].viewport, { width:430, height:932, deviceScaleFactor:2, isMobile:true, hasTouch:true });
  const nonce = calls[0].selector.match(/data-deal-image-ready="([a-f0-9]+)"/)?.[1];
  assert.ok(nonce);
  assert.equal(calls[0].selector, bubbleAdapter.screenshotSelector(nonce));
  assert.equal(calls[0].waitForSelector.selector, bubbleAdapter.readySelector(nonce));
  assert.ok(calls[0].addScriptTag[0].content.includes('form[action*="/cart/add"]'));
  assert.ok(calls[0].addScriptTag[0].content.includes('image.decode()'));
  assert.ok(calls[0].addScriptTag[0].content.includes("location.hostname === 'hellobubble.com'"));
  assert.equal(calls[0].addStyleTag, undefined);
  assert.equal(calls[0].html, undefined);
  assert.equal(calls[0].url, resolved);
  assert.ok(!calls[0].addScriptTag[0].content.includes('max-height'));
  assert.ok(!calls[0].addScriptTag[0].content.includes('overflow'));
  await assert.rejects(renderer.screenshotProductPage('https://evil.example.org/', bubbleAdapter), { code:'UNSAFE_SCREENSHOT_URL' });
});

test('Bubble final-host script cannot mark a cross-domain page screenshot-ready', async () => {
  const script = bubbleAdapter.readyScript('bubblenonce');
  const MutationObserver = class { observe() {} };
  const blockedDocument = { querySelector: () => { throw new Error('DOM must not be inspected on a disallowed host'); } };
  vm.runInNewContext(script, { location:{hostname:'evil.example.org'}, document:blockedDocument, MutationObserver });
  await Promise.resolve();

  const image={currentSrc:'https://cdn.shopify.com/product.png',src:'',naturalWidth:600,complete:true,decode:()=>Promise.resolve()};
  const form={querySelector:()=>({})};
  const region={dataset:{},isConnected:true,textContent:'Water Slide $17 Add to cart',contains:node=>node===form,querySelectorAll:()=>[image],querySelector:()=>({}),parentElement:null};
  const title={parentElement:region};
  const root={querySelector:selector=>selector==='h1'?title:null,querySelectorAll:()=>[form]};
  const allowedDocument={querySelector:()=>root};
  vm.runInNewContext(script,{location:{hostname:'www.hellobubble.com'},document:allowedDocument,MutationObserver});
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(region.dataset.dealImageReady,'bubblenonce');
  assert.equal(region.dataset.dealScreenshotStore,'bubble');
  assert.ok(bubbleAdapter.screenshotSelector('bubblenonce').includes('[data-deal-screenshot-store="bubble"]'));
  assert.ok(bubbleAdapter.screenshotSelector('bubblenonce').includes('[data-deal-image-ready="bubblenonce"]'));
});

test('direct Bubble URL redirecting cross-store is rejected before rendering', async () => {
  let calls = 0;
  await assert.rejects(processProductLink(resolved, {
    fetcher: async () => ++calls === 1 ? new Response(null,{status:302,headers:{location:'https://www.walmart.com/ip/123'}}) : new Response('<html></html>'),
    dnsCheck: async () => {}, copyProvider:{generate:async()=>{throw Error('AI called');}},
    renderer:{screenshot:async()=>{throw Error('card renderer called');}},
    pageRenderer:{screenshotProductPage:async()=>{throw Error('page renderer called');}},
    disclosure:'#Ad', requestId:'bubble-redirect-test'
  }), { code:'UNSAFE_SCREENSHOT_URL' });
  assert.equal(calls, 2);
});

test('Bubble orchestration bypasses Walmart cache/card, preserves affiliate URL and returns PNG', async () => {
  let fetches=0, ai=0, pages=0, cards=0, cache=0;
  let aiProduct;
  const logs=[]; const original=console.log;
  console.log=line=>logs.push(JSON.parse(line));
  try {
    const result = await processProductLink(input, {
      fetcher: async () => { fetches++; return fetches===1 ? new Response(null,{status:302,headers:{location:resolved}}) : new Response(html,{headers:{'content-type':'text/html'}}); },
      dnsCheck: async () => {},
      copyProvider:{generate:async product=>{ai++;aiProduct=product;return {shortTitle:'Bubble Water Slide Serum'};}},
      renderer:{screenshot:async()=>{cards++;throw Error('Walmart renderer called');}},
      pageRenderer:{screenshotProductPage:async(target,adapter)=>{pages++;assert.equal(target,resolved);assert.equal(adapter.store,'bubble');return {bytes:png,mimeType:'image/png'};}},
      cardCache:{lookup:async()=>{cache++;throw Error('Cache called');}},
      disclosure:'#Ad', requestId:'bubble-flow-test'
    });
    assert.equal(fetches,2); assert.equal(ai,1); assert.equal(pages,1); assert.equal(cards,0); assert.equal(cache,0);
    assert.equal(result.product.postUrl,input);
    assert.equal(result.card.mimeType,'image/png');
    assert.equal(result.content.facebookPost,`#Ad 🚨 Bubble Water Slide Serum is now $17.00, was $25.00.\n\n👉 ${input}`);
    assert.equal(aiProduct.rawTitle,result.product.rawTitle);
    assert.ok(logs.some(log=>log.event==='bubble_extraction_diagnostics'&&log.hasJsonLdProduct===true));
    assert.ok(logs.some(log=>log.event==='card_cache_disabled'&&log.reason==='SCREENSHOT_STORE_CACHE_DISABLED'));
    assert.ok(!JSON.stringify(logs).includes(input));
  } finally { console.log=original; }
});

test('Workers AI request for Bubble contains only raw title and no URLs or prices', async () => {
  const product=extractBubbleProduct(html,input,resolved);
  const requests=[];
  const provider=new WorkersAICopyProvider({run:async(_model,request)=>{requests.push(request);return {response:'{"shortTitle":"Bubble Water Slide Serum"}'};}},'test-model');
  await provider.generate(product);
  const serialized=JSON.stringify(requests);
  assert.ok(serialized.includes(product.rawTitle));
  assert.ok(!serialized.includes(input));
  assert.ok(!serialized.includes(resolved));
  assert.ok(!serialized.includes('$17'));
});
