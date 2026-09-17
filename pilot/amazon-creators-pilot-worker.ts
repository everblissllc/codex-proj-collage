import { WorkersAICopyProvider } from "../src/ai/workers-ai-provider";
import { generateProductCopy } from "../src/ai/generate-product-copy";
import type { CopyProvider } from "../src/ai/provider";
import { workerFetch, type FetchLike } from "../src/network/worker-fetch";
import { BrowserScreenshotRenderer } from "../src/rendering/browser-renderer";
import { renderAmazonCard } from "../src/rendering/render-card";
import { resolveUrl } from "../src/stores/resolve-url";
import { validatePublicUrl } from "../src/stores/safe-url";
import { amazonAsinFromUrl } from "../src/stores/amazon/diagnostics";
import { AmazonCreatorsApiClient, amazonCreatorsGetItemsEndpoint } from "../src/stores/amazon/creators-api-client";
import { mapCreatorsItem } from "../src/stores/amazon/creators-api-product";
import type { CreatorsItem } from "../src/stores/amazon/creators-api-types";
import { AmazonCreatorsTokenManager, creatorsTokenEndpoint, type CreatorsCredentialVersion } from "../src/stores/amazon/creators-token-manager";
import { ProductError, type ProductData } from "../src/types";

type Env = {
  AI: Ai;
  BROWSER: BrowserRun;
  AI_TEXT_MODEL: string;
  AFFILIATE_DISCLOSURE: string;
  AMAZON_CREATORS_CLIENT_ID?: string;
  AMAZON_CREATORS_CLIENT_SECRET?: string;
  AMAZON_CREATORS_CREDENTIAL_VERSION?: string;
  AMAZON_CREATORS_MARKETPLACE?: string;
  AMAZON_CREATORS_PARTNER_TAG?: string;
  PILOT_RUN_SECRET?: string;
};

const PRODUCTS = ["B00MNV8E0C", "B09B2SBHQK", "B09B8V1LZ3", "B08HNBHSQV"] as const;
const REQUIRED_ENV = [
  "AMAZON_CREATORS_CLIENT_ID",
  "AMAZON_CREATORS_CLIENT_SECRET",
  "AMAZON_CREATORS_CREDENTIAL_VERSION",
  "AMAZON_CREATORS_MARKETPLACE",
  "AMAZON_CREATORS_PARTNER_TAG",
  "PILOT_RUN_SECRET"
] as const;

type RequestObservation = { asin?: string; status: number; startedAt: number };
type PilotCard = { filename: string; pngBase64: string };

export function secureEqual(actual: string | null, expected: string | null | undefined): boolean {
  if (!actual || !expected || actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index++) difference |= actual.charCodeAt(index) ^ expected.charCodeAt(index);
  return difference === 0;
}

function allowedAmazonHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return lower === "amazon.com" || lower.endsWith(".amazon.com");
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 8192) binary += String.fromCharCode(...bytes.subarray(index, index + 8192));
  return btoa(binary);
}

function pngDimensions(bytes: Uint8Array): { width: number; height: number } | undefined {
  if (bytes.length < 24 || ![137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte)) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

function listingSummary(item: CreatorsItem) {
  const listings = item.offersV2?.listings ?? [];
  const selected = listings.find(listing => listing.isBuyBoxWinner === true) ?? (listings.length === 1 ? listings[0] : undefined);
  const basis = selected?.price?.savingBasis;
  return {
    returnedAsin: item.asin,
    asinMatches: false,
    titlePresent: Boolean(item.itemInfo?.title?.displayValue?.trim()),
    primaryImagePresent: Boolean(item.images?.primary?.large?.url),
    currentPricePresent: Boolean(selected?.price?.money?.displayAmount),
    apiCurrentPrice: selected?.price?.money?.displayAmount,
    currency: selected?.price?.money?.currency,
    savingBasisPresent: Boolean(basis?.money?.displayAmount),
    savingBasisAmount: basis?.money?.displayAmount,
    savingBasisType: basis?.savingBasisType,
    savingsPercentagePresent: typeof selected?.price?.savings?.percentage === "number",
    savingsPercentage: selected?.price?.savings?.percentage,
    dealDetailsPresent: Boolean(selected?.dealDetails),
    listingType: selected?.type,
    condition: selected?.condition?.value,
    availability: selected?.availability?.type,
    buyBoxWinner: selected?.isBuyBoxWinner,
    restrictedAccessDetected: listings.some(listing => {
      const access = listing.dealDetails?.accessType?.replace(/[^a-z0-9]/gi, "").toUpperCase();
      return Boolean(access && access !== "ALL");
    }),
    mapRestrictionDetected: listings.some(listing => listing.violatesMAP === true)
  };
}

function safeErrorCode(error: unknown): string {
  return error instanceof ProductError ? error.code : "PILOT_FAILED";
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

async function runPilot(env: Env): Promise<Response> {
  const missing = REQUIRED_ENV.filter(key => !env[key]);
  if (missing.length) return jsonResponse({ success: false, errorCode: "PILOT_CONFIG_MISSING", missingKeys: missing }, 500);
  if (!["3.1", "3.2", "3.3"].includes(env.AMAZON_CREATORS_CREDENTIAL_VERSION!)) {
    return jsonResponse({ success: false, errorCode: "PILOT_CONFIG_INVALID", invalidKey: "AMAZON_CREATORS_CREDENTIAL_VERSION" }, 500);
  }

  const tokenRequests: Array<{ status: number; lifetimeSeconds?: number }> = [];
  const getItemsRequests: RequestObservation[] = [];
  let activeAsin: string | undefined;
  const observedFetch: FetchLike = async (input, init) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const response = await workerFetch(input, init);
    if (url.href === creatorsTokenEndpoint(env.AMAZON_CREATORS_CREDENTIAL_VERSION! as CreatorsCredentialVersion)) {
      let lifetimeSeconds: number | undefined;
      if (response.ok) {
        try {
          const payload = await response.clone().json() as { expires_in?: unknown };
          if (typeof payload.expires_in === "number") lifetimeSeconds = payload.expires_in;
        } catch { /* Only the numeric lifetime is retained. */ }
      }
      tokenRequests.push({ status: response.status, lifetimeSeconds });
    } else if (url.href === amazonCreatorsGetItemsEndpoint) {
      getItemsRequests.push({ asin: activeAsin, status: response.status, startedAt: Date.now() });
    }
    return response;
  };

  const tokenManager = new AmazonCreatorsTokenManager({
    clientId: env.AMAZON_CREATORS_CLIENT_ID!,
    clientSecret: env.AMAZON_CREATORS_CLIENT_SECRET!,
    credentialVersion: env.AMAZON_CREATORS_CREDENTIAL_VERSION as CreatorsCredentialVersion
  }, observedFetch);
  const client = new AmazonCreatorsApiClient(tokenManager, {
    marketplace: env.AMAZON_CREATORS_MARKETPLACE!,
    partnerTag: env.AMAZON_CREATORS_PARTNER_TAG!
  }, observedFetch);
  const renderer = new BrowserScreenshotRenderer(env.BROWSER);
  const underlyingCopy = new WorkersAICopyProvider(env.AI, env.AI_TEXT_MODEL);
  const results: Array<Record<string, unknown>> = [];
  const cards: PilotCard[] = [];

  for (let index = 0; index < PRODUCTS.length; index++) {
    if (index > 0) await new Promise(resolve => setTimeout(resolve, 1100));
    const requestedAsin = PRODUCTS[index];
    const originalUrl = `https://www.amazon.com/dp/${requestedAsin}?tag=${encodeURIComponent(env.AMAZON_CREATORS_PARTNER_TAG!)}&ref_=creators_api_pilot`;
    const requestId = `amazon-creators-pilot-${index + 1}`;
    const result: Record<string, unknown> = { requestedAsin, apiSuccess: false, offerAccepted: false };
    try {
      validatePublicUrl(originalUrl);
      const resolved = await resolveUrl(originalUrl, workerFetch);
      await resolved.response.body?.cancel();
      const resolvedUrl = validatePublicUrl(resolved.resolvedUrl);
      if (!allowedAmazonHost(resolvedUrl.hostname)) throw new ProductError("UNSAFE_AMAZON_URL", "url", "Amazon redirect left approved hostname");
      const asin = amazonAsinFromUrl(resolvedUrl.href);
      if (asin !== requestedAsin) throw new ProductError("AMAZON_ASIN_MISMATCH", "extraction", "Resolved ASIN mismatch");
      result.resolvedHostname = resolvedUrl.hostname;
      result.redirectCount = resolved.redirectCount;
      result.resolvedAsinMatches = true;

      activeAsin = asin;
      const item = await client.getItem(asin, requestId);
      Object.assign(result, listingSummary(item), { apiSuccess: true, asinMatches: item.asin?.toUpperCase() === asin });
      const product = mapCreatorsItem(item, asin, originalUrl, resolvedUrl.href);
      Object.assign(result, {
        offerAccepted: true,
        currentPrice: product.currentPrice.formatted,
        referencePrice: product.oldPrice?.formatted,
        referencePriceType: product.amazon?.referencePriceType,
        exactOriginalUrlPreserved: product.postUrl === originalUrl
      });

      const aiObservation = { calls: 0, sawUrl: false, sawAsin: false, sawPrice: false };
      const copyProvider: CopyProvider = {
        async generate(rawTitle, correctionReason) {
          aiObservation.calls++;
          aiObservation.sawUrl ||= /https?:\/\//i.test(rawTitle);
          aiObservation.sawAsin ||= rawTitle.includes(asin);
          aiObservation.sawPrice ||= rawTitle.includes(product.currentPrice.formatted) || Boolean(product.oldPrice && rawTitle.includes(product.oldPrice.formatted));
          return underlyingCopy.generate(rawTitle, correctionReason);
        }
      };
      const content = await generateProductCopy(product, copyProvider, env.AFFILIATE_DISCLOSURE);
      const renderStarted = Date.now();
      const card = await renderAmazonCard(product, content, renderer, workerFetch, undefined, requestId);
      const dimensions = pngDimensions(card.bytes);
      const filename = `amazon-card-pilot-${asin}.png`;
      cards.push({ filename, pngBase64: encodeBase64(card.bytes) });
      Object.assign(result, {
        aiCalls: aiObservation.calls,
        aiReceivedUrl: aiObservation.sawUrl,
        aiReceivedAsin: aiObservation.sawAsin,
        aiReceivedPrice: aiObservation.sawPrice,
        facebookCopy: content.facebookPost.replace(originalUrl, "<EXACT_ORIGINAL_AFFILIATE_URL>"),
        facebookCopyPreservedOriginalUrl: content.facebookPost.endsWith(originalUrl),
        pngWidth: dimensions?.width,
        pngHeight: dimensions?.height,
        pngBytes: card.bytes.byteLength,
        renderDurationMs: Date.now() - renderStarted,
        renderedCurrentPrice: product.currentPrice.formatted,
        renderedReferencePrice: product.oldPrice?.formatted,
        referenceWording: product.amazon?.referencePriceType === "LIST_PRICE" ? "list price" : product.oldPrice ? "was" : "none",
        artifactFilename: filename
      });
    } catch (error) {
      result.rejectionReason = safeErrorCode(error);
      if (error instanceof ProductError && ["AMAZON_CREATORS_AUTH_FAILED", "AMAZON_CREATORS_RATE_LIMITED", "AMAZON_CREATORS_API_ERROR", "AMAZON_CREATORS_TIMEOUT"].includes(error.code)) {
        results.push(result);
        break;
      }
    } finally {
      activeAsin = undefined;
    }
    results.push(result);
  }

  const successfulGetItems = getItemsRequests.filter(request => request.status >= 200 && request.status < 300);
  const gaps = getItemsRequests.slice(1).map((request, index) => request.startedAt - getItemsRequests[index].startedAt);
  const accepted = results.filter(result => result.offerAccepted === true);
  const success = accepted.length > 0 && cards.length === accepted.length && tokenRequests.some(request => request.status >= 200 && request.status < 300);
  return jsonResponse({
    success,
    source: "amazon-creators-api",
    amazonHtmlExtractionUsed: false,
    amazonBrowserNavigationUsed: false,
    amazonCardCacheUsed: false,
    token: {
      requestCount: tokenRequests.length,
      statuses: tokenRequests.map(request => request.status),
      lifetimeSeconds: tokenRequests.find(request => request.lifetimeSeconds)?.lifetimeSeconds,
      reusedWithinIsolate: successfulGetItems.length >= 2 && tokenRequests.length === 1
    },
    rate: {
      getItemsRequestCount: getItemsRequests.length,
      statuses: getItemsRequests.map(request => request.status),
      minimumRequestGapMs: gaps.length ? Math.min(...gaps) : undefined,
      sequential: true
    },
    results,
    cards
  }, success ? 200 : 502);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return jsonResponse({ ok: true });
    if (url.pathname !== "/pilot" || request.method !== "POST") return new Response("Not found", { status: 404 });
    if (!env.PILOT_RUN_SECRET) return jsonResponse({ success: false, errorCode: "PILOT_BOOTSTRAP_NOT_READY", missingKeys: ["PILOT_RUN_SECRET"] }, 503);
    if (!secureEqual(request.headers.get("x-pilot-secret"), env.PILOT_RUN_SECRET)) return jsonResponse({ success: false, errorCode: "PILOT_UNAUTHORIZED" }, 401);
    return runPilot(env);
  }
};
