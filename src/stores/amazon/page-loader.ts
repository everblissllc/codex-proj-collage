import { ProductError } from "../../types";
import { validatePublicUrl } from "../safe-url";

export type AmazonPageContent = { html: string; resolvedUrl: string; httpStatus: number; responseByteLength: number; redirectCount: number };
export interface AmazonPageLoader { load(url: string, requestId?: string): Promise<AmazonPageContent>; }

function allowedAmazonHost(hostname: string): boolean { return hostname === "amazon.com" || hostname.endsWith(".amazon.com"); }

export class BrowserAmazonPageLoader implements AmazonPageLoader {
  constructor(private readonly browser: BrowserRun) {}
  async load(url: string, requestId?: string): Promise<AmazonPageContent> {
    const initial = validatePublicUrl(url);
    if (!allowedAmazonHost(initial.hostname.toLowerCase())) throw new ProductError("UNSAFE_AMAZON_URL", "url", "Amazon browser URL rejected");
    const started = Date.now();
    const response = await this.browser.quickAction("content", { url: initial.href, gotoOptions: { waitUntil: "domcontentloaded", timeout: 20_000 }, actionTimeout: 10_000, cacheTTL: 0 });
    if (!response.ok) { await response.body?.cancel(); throw new ProductError("AMAZON_BROWSER_ERROR", "extraction", `Amazon Browser content returned HTTP ${response.status}`); }
    const payload = await response.json() as { success?: boolean; result?: unknown; meta?: { status?: number; finalUrl?: string; redirectChain?: unknown[] } };
    if (!payload.success || typeof payload.result !== "string" || typeof payload.meta?.finalUrl !== "string") throw new ProductError("AMAZON_BROWSER_ERROR", "extraction", "Amazon Browser content response invalid");
    const finalUrl = validatePublicUrl(payload.meta.finalUrl);
    if (!allowedAmazonHost(finalUrl.hostname.toLowerCase())) throw new ProductError("UNSAFE_AMAZON_URL", "url", "Amazon browser redirected outside the approved domain");
    const responseByteLength = new TextEncoder().encode(payload.result).byteLength;
    if (responseByteLength > 3_000_000) throw new ProductError("PAGE_TOO_LARGE", "extraction", "Amazon Browser page too large");
    console.log(JSON.stringify({ event: "amazon_browser_content_complete", requestId, hostname: finalUrl.hostname, httpStatus: payload.meta.status, responseByteLength, redirectCount: Array.isArray(payload.meta.redirectChain) ? payload.meta.redirectChain.length : 0, browserDurationMs: Date.now() - started }));
    return { html: payload.result, resolvedUrl: finalUrl.href, httpStatus: payload.meta.status ?? 0, responseByteLength, redirectCount: Array.isArray(payload.meta.redirectChain) ? payload.meta.redirectChain.length : 0 };
  }
}
