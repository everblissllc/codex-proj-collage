import { ProductError } from "../../types";
import type { FetchLike } from "../../network/worker-fetch";
import { workerFetch } from "../../network/worker-fetch";
import type { SovrnClientConfig, SovrnStoreId } from "./types";

export class SovrnApiError extends ProductError {
  constructor(code: string, message: string, public readonly httpStatus?: number) {
    super(code, "extraction", message);
    this.name = "SovrnApiError";
  }
}

export type SovrnApiResult = { httpStatus: number; value: unknown };

const sleepDefault = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));
const boundedRetryAfter = (value: string | null): number => {
  const seconds = value && /^\d+$/.test(value.trim()) ? Number(value) : 1;
  return Math.min(5_000, Math.max(250, seconds * 1000));
};

async function safeJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (text.length > 2_000_000) throw new ProductError("SOVRN_API_ERROR", "extraction", "Sovrn response too large");
  try { return JSON.parse(text) as unknown; }
  catch { throw new ProductError("SOVRN_API_ERROR", "extraction", "Sovrn response was not valid JSON"); }
}

export class SovrnClient {
  constructor(
    private readonly config: SovrnClientConfig,
    private readonly fetcher: FetchLike = workerFetch,
    private readonly sleep: (ms: number) => Promise<void> = sleepDefault
  ) {}

  async compareByPlainlink(input: { plainlink: string; store: SovrnStoreId; requestId?: string }): Promise<unknown> {
    return (await this.compareByPlainlinkDetailed(input)).value;
  }

  async compareByPlainlinkDetailed(input: { plainlink: string; store: SovrnStoreId; requestId?: string }): Promise<SovrnApiResult> {
    const base = { requestId: input.requestId, store: input.store, hostname: new URL(input.plainlink).hostname };
    for (let attempt = 1; attempt <= 2; attempt++) {
      const started = Date.now();
      console.log(JSON.stringify({ event: "sovrn_request_started", ...base, attempt }));
      const endpoint = new URL(`https://comparisons.sovrn.com/api/affiliate/v3.5/sites/${encodeURIComponent(this.config.siteApiKey)}/compare/prices/${this.config.market}/by/accuracy`);
      endpoint.searchParams.set("plainlink", input.plainlink);
      let response: Response;
      try {
        response = await this.fetcher(endpoint.href, {
          method: "GET", signal: AbortSignal.timeout(12_000),
          headers: { accept: "application/json", authorization: `secret ${this.config.secretKey}` }
        });
      } catch {
        console.error(JSON.stringify({ event: "sovrn_request_failed", ...base, attempt, errorCode: "SOVRN_TIMEOUT", durationMs: Date.now() - started }));
        throw new SovrnApiError("SOVRN_TIMEOUT", "Sovrn request failed or timed out");
      }
      if (response.status === 429) {
        const retryScheduled = attempt === 1;
        const retryDelayMs = boundedRetryAfter(response.headers.get("retry-after"));
        await response.body?.cancel();
        console.warn(JSON.stringify({ event: "sovrn_request_failed", ...base, attempt, httpStatus: 429, errorCode: "SOVRN_RATE_LIMITED", retryScheduled, retryDelayMs: retryScheduled ? retryDelayMs : undefined, durationMs: Date.now() - started }));
        if (retryScheduled) { await this.sleep(retryDelayMs); continue; }
        throw new SovrnApiError("SOVRN_RATE_LIMITED", "Sovrn rate limit exceeded", 429);
      }
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        console.error(JSON.stringify({ event: "sovrn_request_failed", ...base, attempt, httpStatus: response.status, errorCode: "SOVRN_AUTH_FAILED", durationMs: Date.now() - started }));
        throw new SovrnApiError("SOVRN_AUTH_FAILED", "Sovrn authorization failed", response.status);
      }
      if (!response.ok) {
        await response.body?.cancel();
        console.error(JSON.stringify({ event: "sovrn_request_failed", ...base, attempt, httpStatus: response.status, errorCode: "SOVRN_API_ERROR", durationMs: Date.now() - started }));
        throw new SovrnApiError("SOVRN_API_ERROR", `Sovrn returned HTTP ${response.status}`, response.status);
      }
      const value = await safeJson(response);
      console.log(JSON.stringify({ event: "sovrn_request_complete", ...base, attempt, httpStatus: response.status, durationMs: Date.now() - started }));
      return { httpStatus: response.status, value };
    }
    throw new SovrnApiError("SOVRN_RATE_LIMITED", "Sovrn attempts exhausted", 429);
  }
}
