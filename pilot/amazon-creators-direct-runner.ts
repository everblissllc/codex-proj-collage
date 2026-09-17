import { pathToFileURL } from "node:url";
import { AMAZON_CREATORS_RESOURCES, type CreatorsApiError, type CreatorsItem, type GetItemsResponse } from "../src/stores/amazon/creators-api-types.js";

const TOKEN_ENDPOINT = "https://api.amazon.com/auth/o2/token";
const GET_ITEMS_ENDPOINT = "https://creatorsapi.amazon/catalog/v1/getItems";
const TEST_ASIN = "B08HNBHSQV";
const TIMEOUT_MS = 15_000;

type PilotClassification =
  | "CREATORS_AUTH_SUCCESS"
  | "CREATORS_TOKEN_FAILED"
  | "CREATORS_ACCESS_DENIED"
  | "CREATORS_API_ERROR"
  | "CREATORS_RESPONSE_INVALID";

type SafeReport = {
  event: "amazon_creators_direct_pilot_result";
  classification: PilotClassification;
  oauth: { httpStatus?: number; accessTokenReturned: boolean; tokenType?: string; expiresIn?: number };
  getItems?: {
    httpStatus?: number;
    amazonApiErrorType?: string;
    amazonApiErrorCode?: string;
    productDataReturned: boolean;
    returnedAsin?: string;
    asinMatches: boolean;
    titlePresent: boolean;
    pricePresent: boolean;
    imagePresent: boolean;
  };
};

type PilotEnv = {
  AMAZON_CREATORS_CLIENT_ID?: string;
  AMAZON_CREATORS_CLIENT_SECRET?: string;
  AMAZON_CREATORS_MARKETPLACE?: string;
  AMAZON_CREATORS_PARTNER_TAG?: string;
};

const safeIdentifier = (value: unknown): string | undefined =>
  typeof value === "string" && value.length <= 120 && /^[A-Za-z0-9_.:-]+$/.test(value) ? value : undefined;

async function fetchOnce(fetcher: typeof fetch, url: string, init: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try { return await fetcher(url, { ...init, signal: controller.signal }); }
  finally { clearTimeout(timeout); }
}

async function jsonObject(response: Response): Promise<Record<string, unknown> | undefined> {
  try {
    const value: unknown = await response.json();
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function apiError(payload: Record<string, unknown> | undefined): CreatorsApiError | undefined {
  if (!payload) return undefined;
  const errors = payload.errors;
  if (Array.isArray(errors) && errors[0] && typeof errors[0] === "object") return errors[0] as CreatorsApiError;
  return payload as CreatorsApiError;
}

function items(payload: Record<string, unknown>): CreatorsItem[] {
  const typed = payload as GetItemsResponse;
  return typed.itemsResult?.items ?? typed.itemResults?.items ?? [];
}

export async function runAmazonCreatorsDirectPilot(env: PilotEnv, fetcher: typeof fetch = fetch): Promise<SafeReport> {
  const clientId = env.AMAZON_CREATORS_CLIENT_ID;
  const clientSecret = env.AMAZON_CREATORS_CLIENT_SECRET;
  const marketplace = env.AMAZON_CREATORS_MARKETPLACE;
  const partnerTag = env.AMAZON_CREATORS_PARTNER_TAG;
  if (!clientId || !clientSecret || !marketplace || !partnerTag) {
    return { event: "amazon_creators_direct_pilot_result", classification: "CREATORS_TOKEN_FAILED", oauth: { accessTokenReturned: false } };
  }

  let tokenResponse: Response;
  try {
    tokenResponse = await fetchOnce(fetcher, TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "creatorsapi::default"
      })
    });
  } catch {
    return { event: "amazon_creators_direct_pilot_result", classification: "CREATORS_TOKEN_FAILED", oauth: { accessTokenReturned: false } };
  }
  const tokenPayload = await jsonObject(tokenResponse);
  const accessToken = typeof tokenPayload?.access_token === "string" && tokenPayload.access_token ? tokenPayload.access_token : undefined;
  const tokenType = safeIdentifier(tokenPayload?.token_type);
  const expiresIn = typeof tokenPayload?.expires_in === "number" && Number.isFinite(tokenPayload.expires_in) ? tokenPayload.expires_in : undefined;
  const oauth = { httpStatus: tokenResponse.status, accessTokenReturned: Boolean(accessToken), tokenType, expiresIn };
  if (!tokenResponse.ok) return { event: "amazon_creators_direct_pilot_result", classification: "CREATORS_TOKEN_FAILED", oauth };
  if (!tokenPayload || !accessToken) return { event: "amazon_creators_direct_pilot_result", classification: "CREATORS_RESPONSE_INVALID", oauth };

  let response: Response;
  try {
    response = await fetchOnce(fetcher, GET_ITEMS_ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${accessToken}`, "content-type": "application/json", "x-marketplace": marketplace },
      body: JSON.stringify({
        itemIds: [TEST_ASIN], itemIdType: "ASIN", marketplace, partnerTag, condition: "New", resources: AMAZON_CREATORS_RESOURCES
      })
    });
  } catch {
    return {
      event: "amazon_creators_direct_pilot_result", classification: "CREATORS_API_ERROR", oauth,
      getItems: { productDataReturned: false, asinMatches: false, titlePresent: false, pricePresent: false, imagePresent: false }
    };
  }

  const payload = await jsonObject(response);
  const error = apiError(payload);
  const exact = payload ? items(payload).find(item => item.asin?.toUpperCase() === TEST_ASIN) : undefined;
  const titlePresent = Boolean(exact?.itemInfo?.title?.displayValue);
  const imagePresent = Boolean(exact?.images?.primary?.large?.url);
  const pricePresent = Boolean(exact?.offersV2?.listings?.some(listing => {
    const amount = listing.price?.money?.amount;
    return typeof amount === "number" && Number.isFinite(amount) && amount > 0;
  }));
  const getItems = {
    httpStatus: response.status,
    amazonApiErrorType: safeIdentifier(error?.type),
    amazonApiErrorCode: safeIdentifier(error?.code),
    productDataReturned: Boolean(exact),
    returnedAsin: safeIdentifier(exact?.asin),
    asinMatches: Boolean(exact),
    titlePresent,
    pricePresent,
    imagePresent
  };
  if (response.status === 403) return { event: "amazon_creators_direct_pilot_result", classification: "CREATORS_ACCESS_DENIED", oauth, getItems };
  if (!response.ok || error) return { event: "amazon_creators_direct_pilot_result", classification: "CREATORS_API_ERROR", oauth, getItems };
  if (!payload || !exact || !titlePresent || !pricePresent || !imagePresent) {
    return { event: "amazon_creators_direct_pilot_result", classification: "CREATORS_RESPONSE_INVALID", oauth, getItems };
  }
  return { event: "amazon_creators_direct_pilot_result", classification: "CREATORS_AUTH_SUCCESS", oauth, getItems };
}

async function main(): Promise<void> {
  const report = await runAmazonCreatorsDirectPilot(process.env);
  console.log(JSON.stringify(report));
  if (report.classification !== "CREATORS_AUTH_SUCCESS") process.exitCode = 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error(JSON.stringify({ event: "amazon_creators_direct_pilot_result", classification: "CREATORS_API_ERROR", oauth: { accessTokenReturned: false } }));
    process.exitCode = 2;
  });
}
