import { ProductError } from "../types";
import { assertPublicDns, validatePublicUrl, type DnsCheck } from "./safe-url";
import { workerFetch, type FetchLike } from "../network/worker-fetch";

export type ResolvedPage = { resolvedUrl: string; response: Response };

export async function resolveUrl(inputUrl: string, fetcher: FetchLike = workerFetch, accept = "text/html,application/xhtml+xml", dnsCheck: DnsCheck = assertPublicDns): Promise<ResolvedPage> {
  let current = validatePublicUrl(inputUrl);
  const seen = new Set<string>();
  for (let hop = 0; hop <= 5; hop++) {
    if (seen.has(current.href)) throw new ProductError("REDIRECT_LOOP", "url", "Redirect loop");
    seen.add(current.href);
    try { await dnsCheck(current.hostname); }
    catch (error) { if (error instanceof ProductError) throw error; throw new ProductError("DNS_CHECK_FAILED", "url", String(error)); }
    let response: Response;
    try {
      response = await fetcher(current.href, {
        redirect: "manual",
        signal: AbortSignal.timeout(12000),
        headers: { "accept": accept, "user-agent": "Mozilla/5.0 (compatible; DealCardBot/1.0)" }
      });
    } catch (error) { throw new ProductError("FETCH_FAILED", "extraction", String(error)); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new ProductError("REDIRECT_MISSING_LOCATION", "url", "Redirect without Location");
      current = validatePublicUrl(new URL(location, current).href);
      await response.body?.cancel();
      continue;
    }
    // No automatic redirects: each destination is validated before it is fetched.
    return { resolvedUrl: current.href, response };
  }
  throw new ProductError("TOO_MANY_REDIRECTS", "url", "Too many redirects");
}

export async function readLimitedText(response: Response, maxBytes = 3_000_000): Promise<string> {
  if (!response.ok) throw new ProductError("STORE_HTTP_ERROR", "extraction", `Store returned HTTP ${response.status}`);
  const type = response.headers.get("content-type") ?? "";
  if (type && !/(text\/html|application\/xhtml\+xml)/i.test(type)) throw new ProductError("NOT_HTML", "extraction", `Unexpected content type ${type}`);
  if (Number(response.headers.get("content-length")) > maxBytes) throw new ProductError("PAGE_TOO_LARGE", "extraction", "Page too large");
  const reader = response.body?.getReader();
  if (!reader) throw new ProductError("EMPTY_PAGE", "extraction", "No response body");
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) { await reader.cancel(); throw new ProductError("PAGE_TOO_LARGE", "extraction", "Page too large"); }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(out);
}
