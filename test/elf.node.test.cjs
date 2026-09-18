const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const vm = require('node:vm');
const src = path => require(join(process.env.COMPILED_ROOT, path));
const { detectStore } = src('stores/detect-store.js');
const { extractElfProduct, inspectElfHtml, elfAdapter } = src('stores/screenshot/elf.js');
const { BrowserMobilePageRenderer } = src('rendering/mobile-page-renderer.js');
const { processProductLink } = src('orchestration/process-product-link.js');
const { WorkersAICopyProvider } = src('ai/workers-ai-provider.js');
const { buildFacebookComment, buildFacebookPost } = src('ai/build-facebook-post.js');
const html = readFileSync('test/fixtures/elf-product.html', 'utf8');
const input = 'https://affiliate.example.org/go?tag=UserA%2B1&x=2';
const resolved = 'https://www.elfcosmetics.com/products/hydrating-camo-concealer/';
const png = Uint8Array.from([137,80,78,71,13,10,26,10,1]);
const response = (status=200, headers={}) => new Response(status===200 ? png : 'error', {status,headers});

test('e.l.f. exact-domain detection rejects lookalikes', () => {
  assert.equal(detectStore('https://elfcosmetics.com/products/test'), 'elf');
  assert.equal(detectStore(resolved), 'elf');
  assert.equal(detectStore('https://fakeelfcosmetics.com/products/test'), undefined);
});
test('e.l.f. JSON-LD extraction keeps authoritative prices and original link', () => {
  const p = extractElfProduct(html,input,resolved);
  assert.equal(p.rawTitle,'Hydrating Camo Concealer');
  assert.equal(p.imageUrl,'https://cdn.shopify.com/files/concealer.png');
  assert.equal(p.currentPrice.formatted,'$8.00');
  assert.equal(p.oldPrice.formatted,'$12.00');
  assert.equal(p.currentPrice.currency,'USD');
  assert.equal(p.postUrl,input);
  assert.equal(p.canonicalProductUrl,resolved);
  assert.deepEqual(inspectElfHtml(html),{hasJsonLdProduct:true,hasProductRegion:true,hasOgTitle:true,hasPriceOffer:true,challengeDetected:false});
  const noOld=extractElfProduct(html.replace('"wasPrice":12','"highPrice":12'),input,resolved);
  assert.equal(noOld.oldPrice,undefined);
});
test('e.l.f. rejects missing/malformed price and non-product pages', () => {
  assert.throws(()=>extractElfProduct(html.replace('"price":8','"price":"Call"'),input,resolved),{code:'MISSING_PRICE'});
  assert.throws(()=>extractElfProduct(html.replace('"price":8,',''),input,resolved),{code:'MISSING_PRICE'});
  assert.throws(()=>extractElfProduct('<html><h1>Sale</h1></html>',input,resolved),{code:'NOT_PRODUCT_PAGE'});
});
test('e.l.f. Facebook post uses current price while comment uses exact original link',()=>{
  const product=extractElfProduct(html.replace('"wasPrice":12','"highPrice":12'),input,resolved);
  const post=buildFacebookPost(product,'Hydrating Camo Concealer');
  assert.match(post,/\$8\.00/);
  assert.doesNotMatch(post,/#Ad|https?:\/\//i);
  assert.ok(buildFacebookComment(product).endsWith(input));
});
test('mobile Browser Quick Action uses supported viewport, region selector and validates PNG', async () => {
  const calls=[];
  const renderer=new BrowserMobilePageRenderer({quickAction:async (_action,options)=>{calls.push(options);return response();}});
  const card=await renderer.screenshotProductPage(resolved,elfAdapter,'elf-render-test');
  assert.deepEqual(card.bytes,png);
  assert.equal(calls.length,1);
  assert.equal(calls[0].url,resolved);
  assert.deepEqual(calls[0].viewport,{width:430,height:932,deviceScaleFactor:2,isMobile:true,hasTouch:true});
  const nonce = calls[0].selector.match(/data-deal-image-ready="([a-f0-9]+)"/)?.[1];
  assert.ok(nonce);
  assert.equal(calls[0].waitForSelector.selector,elfAdapter.readySelector(nonce));
  assert.equal(calls[0].selector,elfAdapter.screenshotSelector(nonce));
  assert.ok(calls[0].addScriptTag[0].content.includes('image.decode()'));
  assert.ok(calls[0].addScriptTag[0].content.includes("location.hostname !== 'elfcosmetics.com'"));
  assert.ok(calls[0].addScriptTag[0].content.includes(`region.dataset.dealImageReady = '${nonce}'`));
  assert.equal(calls[0].addStyleTag,undefined);
  assert.equal(calls[0].gotoOptions.waitUntil,'domcontentloaded');
  assert.equal(calls[0].cacheTTL,0);
  assert.equal(calls[0].html,undefined);
  await assert.rejects(renderer.screenshotProductPage('https://evil.example.org/',elfAdapter),{code:'UNSAFE_SCREENSHOT_URL'});
  const bad=new BrowserMobilePageRenderer({quickAction:async()=>new Response('not png')});
  await assert.rejects(bad.screenshotProductPage(resolved,elfAdapter),{code:'BROWSER_BAD_IMAGE'});
});
test('e.l.f. final-host script cannot mark a cross-domain page screenshot-ready',async()=>{
  const nonce='testnonce';
  const script=elfAdapter.readyScript(nonce);
  const run=async hostname=>{
    const region={dataset:{},querySelector:selector=>selector==='img[loading="eager"]'?{decode:()=>Promise.resolve()}:{} };
    const document={querySelector:()=>region};
    const MutationObserver=class{observe(){}};
    vm.runInNewContext(script,{location:{hostname},document,MutationObserver});
    await Promise.resolve();
    return region.dataset;
  };
  assert.equal((await run('evil.example.org')).dealImageReady,undefined);
  assert.equal((await run('elfcosmetics.com')).dealImageReady,nonce);
  assert.equal((await run('www.elfcosmetics.com')).dealImageReady,nonce);
  assert.ok(elfAdapter.screenshotSelector(nonce).includes(`[data-deal-image-ready="${nonce}"]`));
});
test('e.l.f. direct URL redirecting to another store is rejected before rendering',async()=>{
  let calls=0;
  await assert.rejects(processProductLink(resolved,{
    fetcher:async()=>{calls++;return calls===1?new Response(null,{status:302,headers:{location:'https://www.walmart.com/ip/123'}}):new Response('<html></html>',{headers:{'content-type':'text/html'}});},
    dnsCheck:async()=>{},
    copyProvider:{generate:async()=>{throw Error('AI called');}},
    renderer:{screenshot:async()=>{throw Error('card renderer called');}},
    pageRenderer:{screenshotProductPage:async()=>{throw Error('page renderer called');}},
    disclosure:'#Ad',requestId:'elf-redirect-test'
  }),{code:'UNSAFE_SCREENSHOT_URL'});
  assert.equal(calls,2);
});
test('mobile renderer retries transient 429 once but not usage limit', async () => {
  let calls=0;
  const waits=[];
  const renderer=new BrowserMobilePageRenderer({quickAction:async()=>++calls===1?response(429,{'content-type':'application/json','retry-after':'1'}):response()},async ms=>waits.push(ms),()=>0);
  await renderer.screenshotProductPage(resolved,elfAdapter);
  assert.equal(calls,2);assert.deepEqual(waits,[1000]);
  calls=0;
  const usage=new BrowserMobilePageRenderer({quickAction:async()=>{calls++;return new Response(JSON.stringify({errors:[{message:'Browser time limit exceeded for today'}]}),{status:429,headers:{'content-type':'application/json'}});}},async()=>{});
  await assert.rejects(usage.screenshotProductPage(resolved,elfAdapter),{code:'BROWSER_ERROR'});
  assert.equal(calls,1);
});
test('e.l.f. orchestration bypasses cache, Walmart card, image fetch and preserves each affiliate URL', async () => {
  const urls=[input,'https://affiliate.example.org/go?tag=UserB%2B2&x=3'];
  let ai=0, pages=0, cards=0, cache=0;
  const logs=[];const original=console.log;
  console.log=line=>logs.push(JSON.parse(line));
  try {
    for(const url of urls){
      let fetches=0;
      const result=await processProductLink(url,{
        fetcher:async()=>{fetches++;return fetches===1?new Response(null,{status:302,headers:{location:resolved}}):new Response(html,{headers:{'content-type':'text/html'}});},
        dnsCheck:async()=>{},
        copyProvider:{generate:async()=>{ai++;return {shortTitle:'e.l.f. Hydrating Camo Concealer'};}},
        renderer:{screenshot:async()=>{cards++;throw Error('Walmart renderer called');}},
        pageRenderer:{screenshotProductPage:async (target,adapter)=>{pages++;assert.equal(target,resolved);assert.equal(adapter.store,'elf');return {bytes:png,mimeType:'image/png'};}},
        cardCache:{lookup:async()=>{cache++;throw Error('Cache called');}},
        disclosure:'#Ad',requestId:'elf-'+pages
      });
      assert.equal(fetches,2);
      assert.ok(!result.content.facebookPost.includes(url));
      assert.ok(result.content.facebookComment.endsWith(url));
      assert.ok(!result.content.facebookComment.includes(url===urls[0]?urls[1]:urls[0]));
      assert.ok(result.content.facebookPost.includes('$8.00'));
      assert.ok(!result.content.facebookPost.includes('$12.00'));
    }
    assert.equal(ai,2);assert.equal(pages,2);assert.equal(cards,0);assert.equal(cache,0);
    assert.equal(logs.filter(x=>x.event==='card_cache_disabled'&&x.reason==='SCREENSHOT_STORE_CACHE_DISABLED').length,2);
    assert.ok(!JSON.stringify(logs).includes(input));
  }finally{console.log=original;}
});
test('Workers AI receives only raw e.l.f. title, never affiliate or price URLs',async()=>{
  const p=extractElfProduct(html,input,resolved);
  const requests=[];
  const provider=new WorkersAICopyProvider({run:async (_model,request)=>{requests.push(request);return {response:'{"shortTitle":"Hydrating Camo Concealer"}'};}},'test-model');
  await provider.generate(p.rawTitle);
  assert.equal(requests.length,1);
  assert.equal(requests[0].messages[1].content,JSON.stringify({rawTitle:p.rawTitle}));
  assert.doesNotMatch(requests[0].messages[1].content,/https?:\/\//i);
  assert.ok(!JSON.stringify(requests).includes('$8'));
});
