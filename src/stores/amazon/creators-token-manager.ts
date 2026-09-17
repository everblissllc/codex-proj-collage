import { ProductError } from "../../types";
import type { FetchLike } from "../../network/worker-fetch";

export type CreatorsCredentialVersion = "3.1" | "3.2" | "3.3";
export type CreatorsCredentials = { clientId: string; clientSecret: string; credentialVersion: CreatorsCredentialVersion };
type Token = { value: string; expiresAt: number };

const TOKEN_ENDPOINTS: Record<CreatorsCredentialVersion, string> = {
  "3.1": "https://api.amazon.com/auth/o2/token",
  "3.2": "https://api.amazon.co.uk/auth/o2/token",
  "3.3": "https://api.amazon.co.jp/auth/o2/token"
};
const TOKEN_SAFETY_MARGIN_MS = 60_000;
const TOKEN_TIMEOUT_MS = 10_000;

export class AmazonCreatorsTokenManager {
  private token?: Token;
  private refreshPromise?: Promise<string>;

  constructor(
    private readonly credentials: CreatorsCredentials,
    private readonly fetcher: FetchLike,
    private readonly now: () => number = Date.now
  ) {}

  async getToken(requestId?: string): Promise<string> {
    if (this.token && this.now() < this.token.expiresAt - TOKEN_SAFETY_MARGIN_MS) return this.token.value;
    if (this.refreshPromise) return this.refreshPromise;
    const refresh = this.refresh(requestId);
    this.refreshPromise = refresh;
    try { return await refresh; }
    finally { if (this.refreshPromise === refresh) this.refreshPromise = undefined; }
  }

  invalidate(): void { this.token = undefined; }

  private async refresh(requestId?: string): Promise<string> {
    console.log(JSON.stringify({ event: "amazon_creators_token_refresh_started", requestId }));
    const started = this.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TOKEN_TIMEOUT_MS);
    try {
      const response = await this.fetcher(TOKEN_ENDPOINTS[this.credentials.credentialVersion], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          grant_type: "client_credentials",
          client_id: this.credentials.clientId,
          client_secret: this.credentials.clientSecret,
          scope: "creatorsapi::default"
        }),
        signal: controller.signal
      });
      if (response.status === 429) {
        await response.body?.cancel();
        throw new ProductError("AMAZON_CREATORS_RATE_LIMITED", "extraction", "Creators API token endpoint throttled");
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ProductError("AMAZON_CREATORS_AUTH_FAILED", "extraction", `Creators API authentication returned HTTP ${response.status}`);
      }
      const payload = await response.json() as { access_token?: unknown; expires_in?: unknown; token_type?: unknown };
      if (typeof payload.access_token !== "string" || !payload.access_token || typeof payload.expires_in !== "number" || payload.expires_in <= 0) {
        throw new ProductError("AMAZON_CREATORS_AUTH_FAILED", "extraction", "Creators API authentication response invalid");
      }
      this.token = { value: payload.access_token, expiresAt: this.now() + payload.expires_in * 1000 };
      console.log(JSON.stringify({ event: "amazon_creators_token_refresh_complete", requestId, durationMs: this.now() - started }));
      return this.token.value;
    } catch (error) {
      if (error instanceof ProductError) throw error;
      if (controller.signal.aborted) throw new ProductError("AMAZON_CREATORS_TIMEOUT", "extraction", "Creators API token request timed out");
      throw new ProductError("AMAZON_CREATORS_AUTH_FAILED", "extraction", "Creators API authentication failed");
    } finally { clearTimeout(timeout); }
  }
}

export function creatorsTokenEndpoint(version: CreatorsCredentialVersion): string { return TOKEN_ENDPOINTS[version]; }
