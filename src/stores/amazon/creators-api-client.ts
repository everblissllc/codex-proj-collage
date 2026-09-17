import { ProductError } from "../../types";
import type { FetchLike } from "../../network/worker-fetch";
import { validAsin } from "./diagnostics";
import { AMAZON_CREATORS_RESOURCES, type CreatorsApiError, type CreatorsItem, type GetItemsResponse } from "./creators-api-types";
import type { AmazonCreatorsTokenManager } from "./creators-token-manager";

export type CreatorsApiConfig = { marketplace: string; partnerTag: string };
export type AmazonCreatorsApiDiagnostics = {
  httpStatus: 401 | 403;
  amazonApiErrorType?: string;
  amazonApiErrorCode?: string;
};

export class AmazonCreatorsAuthError extends ProductError {
  constructor(public readonly amazonDiagnostics: AmazonCreatorsApiDiagnostics) {
    super("AMAZON_CREATORS_AUTH_FAILED", "extraction", "Creators API authorization failed");
  }
}

type Wait = (milliseconds: number) => Promise<void>;
const GET_ITEMS_ENDPOINT = "https://creatorsapi.amazon/catalog/v1/getItems";
const REQUEST_TIMEOUT_MS = 10_000;
const RETRY_MIN_MS = 250;
const RETRY_FALLBACK_MS = 1_000;
const RETRY_MAX_MS = 5_000;

function retryDelay(response: Response, error: CreatorsApiError | undefined): number {
  const bodySeconds = typeof error?.retryAfterSeconds === "number" ? error.retryAfterSeconds : undefined;
  const header = response.headers.get("retry-after");
  const headerSeconds = header && /^\d+$/.test(header.trim()) ? Number(header) : undefined;
  const milliseconds = (bodySeconds ?? headerSeconds) !== undefined ? (bodySeconds ?? headerSeconds)! * 1000 : RETRY_FALLBACK_MS;
  return Math.max(RETRY_MIN_MS, Math.min(RETRY_MAX_MS, milliseconds));
}

async function safeJson(response: Response): Promise<GetItemsResponse & CreatorsApiError> {
  try { return await response.json() as GetItemsResponse & CreatorsApiError; }
  catch { return {}; }
}

function safeApiIdentifier(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 120 && /^[A-Za-z0-9_.:-]+$/.test(value) ? value : undefined;
}

export class AmazonCreatorsApiClient {
  constructor(
    private readonly tokens: AmazonCreatorsTokenManager,
    private readonly config: CreatorsApiConfig,
    private readonly fetcher: FetchLike,
    private readonly wait: Wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds))
  ) {}

  async getItem(asin: string, requestId?: string): Promise<CreatorsItem> {
    if (!validAsin(asin)) throw new ProductError("MISSING_PRODUCT_ID", "extraction", "Amazon ASIN invalid");
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(JSON.stringify({ event: "amazon_creators_request_started", requestId, asin, attempt }));
      const started = Date.now();
      const token = await this.tokens.getToken(requestId);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await this.fetcher(GET_ITEMS_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "x-marketplace": this.config.marketplace
          },
          body: JSON.stringify({
            itemIds: [asin],
            itemIdType: "ASIN",
            marketplace: this.config.marketplace,
            partnerTag: this.config.partnerTag,
            condition: "New",
            resources: AMAZON_CREATORS_RESOURCES
          }),
          signal: controller.signal
        });
      } catch {
        if (controller.signal.aborted) throw new ProductError("AMAZON_CREATORS_TIMEOUT", "extraction", "Creators API request timed out");
        throw new ProductError("AMAZON_CREATORS_API_ERROR", "extraction", "Creators API request failed");
      } finally { clearTimeout(timeout); }

      const payload = await safeJson(response);
      const apiError = payload.errors?.[0] ?? (payload.type ? payload : undefined);
      if (response.status === 429) {
        const delayMs = retryDelay(response, apiError);
        console.warn(JSON.stringify({ event: "amazon_creators_request_failed", requestId, asin, attempt, httpStatus: 429, errorCategory: "rate_limited", retryScheduled: attempt === 1, retryDelayMs: attempt === 1 ? delayMs : undefined, durationMs: Date.now() - started }));
        if (attempt === 1) { await this.wait(delayMs); continue; }
        throw new ProductError("AMAZON_CREATORS_RATE_LIMITED", "extraction", "Creators API throttled");
      }
      if (response.status === 401 || response.status === 403) {
        const amazonDiagnostics: AmazonCreatorsApiDiagnostics = {
          httpStatus: response.status,
          amazonApiErrorType: safeApiIdentifier(apiError?.type),
          amazonApiErrorCode: safeApiIdentifier(apiError?.code)
        };
        console.error(JSON.stringify({
          event: "amazon_creators_request_failed", requestId, asin, attempt,
          httpStatus: amazonDiagnostics.httpStatus, errorCategory: "auth",
          amazonApiErrorType: amazonDiagnostics.amazonApiErrorType,
          amazonApiErrorCode: amazonDiagnostics.amazonApiErrorCode,
          durationMs: Date.now() - started
        }));
        throw new AmazonCreatorsAuthError(amazonDiagnostics);
      }
      if (response.status === 404 || apiError?.type === "ResourceNotFoundException" || /ItemNotAccessible|ItemNotFound/i.test(apiError?.code ?? "")) {
        throw new ProductError("AMAZON_ITEM_NOT_FOUND", "extraction", "Amazon item not found");
      }
      if (!response.ok || apiError) {
        console.error(JSON.stringify({ event: "amazon_creators_request_failed", requestId, asin, attempt, httpStatus: response.status, errorCategory: "api", durationMs: Date.now() - started }));
        throw new ProductError("AMAZON_CREATORS_API_ERROR", "extraction", "Creators API returned an error");
      }
      const items = payload.itemsResult?.items ?? payload.itemResults?.items ?? [];
      const exact = items.filter(item => item.asin?.toUpperCase() === asin);
      if (exact.length !== 1) throw new ProductError(items.length ? "AMAZON_ASIN_MISMATCH" : "AMAZON_ITEM_NOT_FOUND", "extraction", "Creators API item identity mismatch");
      console.log(JSON.stringify({ event: "amazon_creators_request_complete", requestId, asin, attempt, httpStatus: response.status, durationMs: Date.now() - started }));
      return exact[0];
    }
    throw new ProductError("AMAZON_CREATORS_RATE_LIMITED", "extraction", "Creators API throttled");
  }
}

export const amazonCreatorsGetItemsEndpoint = GET_ITEMS_ENDPOINT;
export const amazonCreatorsRetryBounds = { minMs: RETRY_MIN_MS, fallbackMs: RETRY_FALLBACK_MS, maxMs: RETRY_MAX_MS } as const;
