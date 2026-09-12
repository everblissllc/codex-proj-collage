import { ProductError } from "../types";

const blockedSuffixes = [".local", ".localhost", ".internal", ".test", ".invalid", ".example", ".onion"];
const blockedHosts = new Set(["localhost", "metadata.google.internal", "metadata", "instance-data", "cloudflare.internal"]);

export function blockedIpv4(host: string): boolean {
  const bytes = host.split(".").map(Number);
  if (bytes.length !== 4 || bytes.some(x => !Number.isInteger(x) || x < 0 || x > 255)) return true;
  const [a, b, c] = bytes;
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
    (a === 192 && b === 0) || (a === 192 && b === 0 && c === 2) ||
    (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
    (a === 203 && b === 0 && c === 113);
}

function blockedIpv6(host: string): boolean {
  const value = host.toLowerCase();
  return value === "::" || value === "::1" || value.startsWith("::ffff:") || value.startsWith("fc") || value.startsWith("fd") ||
    /^fe[89ab]/.test(value) || value.startsWith("ff") || value.startsWith("2001:db8:") || value.includes(".");
}

export type DnsCheck = (hostname: string) => Promise<void>;

export const assertPublicDns: DnsCheck = async hostname => {
  const queries = await Promise.all(["A", "AAAA"].map(async type => {
    const endpoint = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;
    const response = await fetch(endpoint, { headers: { accept: "application/dns-json" }, signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new ProductError("DNS_CHECK_FAILED", "url", `DNS check returned HTTP ${response.status}`);
    return await response.json() as { Status?: number; Answer?: Array<{ type?: number; data?: string }> };
  }));
  let addresses = 0;
  for (const result of queries) {
    if (result.Status !== 0 && result.Status !== 3) throw new ProductError("DNS_CHECK_FAILED", "url", "DNS resolution failed");
    for (const answer of result.Answer ?? []) {
      if (answer.type === 1) {
        addresses++;
        if (!answer.data || blockedIpv4(answer.data)) throw new ProductError("UNSAFE_URL", "url", "DNS resolves to a blocked IPv4 address");
      } else if (answer.type === 28) {
        addresses++;
        if (!answer.data || blockedIpv6(answer.data)) throw new ProductError("UNSAFE_URL", "url", "DNS resolves to a blocked IPv6 address");
      }
    }
  }
  if (!addresses) throw new ProductError("DNS_CHECK_FAILED", "url", "Hostname has no public address");
};

export function validatePublicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ProductError("INVALID_URL", "url", "Invalid URL"); }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password ||
      (url.port && !["80", "443"].includes(url.port)) ||
      !host || host.length > 253 || !host.includes(".") || blockedHosts.has(host) ||
      blockedSuffixes.some(s => host.endsWith(s)) || host.includes(":") ||
      /^[\d.]+$/.test(host) ||
      !/^[a-z0-9.-]+$/.test(host)) {
    throw new ProductError("UNSAFE_URL", "url", "Unsafe URL");
  }
  return url;
}

export type UrlEntity = { type: string; offset: number; length: number; url?: string };

export function findProductUrl(text: string, entities: UrlEntity[] = []): string | undefined {
  for (const entity of entities) {
    if (entity.type === "text_link" && entity.url) return entity.url;
    if (entity.type === "url" && Number.isInteger(entity.offset) && Number.isInteger(entity.length)) {
      const candidate = text.slice(entity.offset, entity.offset + entity.length);
      if (candidate) return candidate;
    }
  }
  const matches = text.match(/https?:\/\/[^\s<>"']+/gi);
  if (!matches?.length) return undefined;
  return matches[0].replace(/[),.!?]+$/, "");
}
