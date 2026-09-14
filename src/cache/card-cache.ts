import { parseCopyDraft } from "../ai/workers-ai-provider";
import type { CardImage } from "../rendering/types";
import type { CacheIdentity, CacheLookup, CardCache } from "./types";

export const CARD_CACHE_DEFAULT_TTL_SECONDS = 86_400;
export const CARD_CACHE_LEASE_MS = 60_000;
export const CARD_CACHE_MAX_PNG_BYTES = 10_000_000;

type CacheRow = {
  status: "building" | "ready";
  short_title: string | null;
  r2_key: string | null;
  mime_type: string | null;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
  hit_count: number;
  lease_until: number | null;
};

export function cardCacheTtlSeconds(value?: string): number {
  if (value === undefined) return CARD_CACHE_DEFAULT_TTL_SECONDS;
  if (!/^\d+$/.test(value)) return CARD_CACHE_DEFAULT_TTL_SECONDS;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? Math.min(86_400, Math.max(300, seconds)) : CARD_CACHE_DEFAULT_TTL_SECONDS;
}

function validPng(bytes: Uint8Array): boolean {
  return bytes.length >= 8 && bytes.length <= CARD_CACHE_MAX_PNG_BYTES &&
    [137, 80, 78, 71, 13, 10, 26, 10].every((byte, index) => bytes[index] === byte);
}

export class D1R2CardCache implements CardCache {
  constructor(private readonly db: D1Database, private readonly bucket: R2Bucket, private readonly ttlSeconds: number = CARD_CACHE_DEFAULT_TTL_SECONDS) {}

  async lookup(identity: CacheIdentity, requestId: string): Promise<CacheLookup> {
    const row = await this.db.prepare("SELECT status, short_title, r2_key, mime_type, created_at, updated_at, expires_at, hit_count, lease_until FROM card_cache WHERE cache_key = ?")
      .bind(identity.key).first<CacheRow>();
    if (!row) return { kind: "miss", reason: "missing" };
    if (row.status === "building") return { kind: "building", leaseUntil: row.lease_until ?? 0 };
    const now = Date.now();
    if (row.status !== "ready" || row.expires_at === null) return { kind: "corrupt", updatedAt: row.updated_at, r2Key: row.r2_key };
    if (row.expires_at <= now) return { kind: "miss", reason: "expired" };
    let shortTitle: string;
    try { shortTitle = parseCopyDraft({ shortTitle: row.short_title }).shortTitle; }
    catch { return { kind: "corrupt", updatedAt: row.updated_at, r2Key: row.r2_key }; }
    if (row.mime_type !== "image/png" || !row.r2_key?.startsWith(identity.r2Prefix)) return { kind: "corrupt", updatedAt: row.updated_at, r2Key: row.r2_key };
    const object = await this.bucket.get(row.r2_key);
    if (!object || object.httpMetadata?.contentType !== "image/png" || object.size < 8 || object.size > CARD_CACHE_MAX_PNG_BYTES) {
      await object?.body?.cancel().catch(() => {});
      return { kind: "corrupt", updatedAt: row.updated_at, r2Key: row.r2_key };
    }
    const bytes = new Uint8Array(await object.arrayBuffer());
    if (!validPng(bytes)) return { kind: "corrupt", updatedAt: row.updated_at, r2Key: row.r2_key };
    try {
      await this.db.prepare("UPDATE card_cache SET hit_count = hit_count + 1, last_accessed_at = ? WHERE cache_key = ? AND status = 'ready' AND r2_key = ?")
        .bind(now, identity.key, row.r2_key).run();
    } catch {
      console.error(JSON.stringify({ event: "card_cache_write_failed", requestId, store: identity.store, canonicalProductId: identity.productId, cacheKeyPrefix: identity.keyPrefix, errorCode: "CACHE_HIT_UPDATE_FAILED" }));
    }
    return { kind: "hit", shortTitle, card: { bytes, mimeType: "image/png" }, ageSeconds: Math.max(0, Math.floor((now - row.created_at) / 1000)), hitCount: row.hit_count + 1 };
  }

  async claim(identity: CacheIdentity, corrupt?: { updatedAt: number; r2Key: string | null }): Promise<string | null> {
    const token = crypto.randomUUID();
    const now = Date.now();
    const result = await this.db.prepare(`
      INSERT INTO card_cache (cache_key, store, product_id, status, created_at, updated_at, lease_until, builder_token)
      VALUES (?, ?, ?, 'building', ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        status = 'building', short_title = NULL, r2_key = NULL, mime_type = NULL,
        created_at = excluded.created_at, updated_at = excluded.updated_at, expires_at = NULL,
        last_accessed_at = NULL, hit_count = 0, lease_until = excluded.lease_until, builder_token = excluded.builder_token
      WHERE (card_cache.status = 'building' AND card_cache.lease_until <= ?)
         OR (card_cache.status = 'ready' AND (card_cache.expires_at <= ? OR (card_cache.updated_at = ? AND card_cache.r2_key IS ? AND ? = 1)))
    `).bind(identity.key, identity.store, identity.productId, now, now, now + CARD_CACHE_LEASE_MS, token,
      now, now, corrupt?.updatedAt ?? -1, corrupt?.r2Key ?? null, corrupt === undefined ? 0 : 1).run();
    return result.meta.changes > 0 ? token : null;
  }

  async store(identity: CacheIdentity, token: string, shortTitle: string, card: CardImage): Promise<void> {
    if (card.mimeType !== "image/png" || !validPng(card.bytes)) throw new Error("Invalid cache card PNG");
    const r2Key = `${identity.r2Prefix}${token}.png`;
    await this.bucket.put(r2Key, card.bytes, { httpMetadata: { contentType: "image/png" } });
    const now = Date.now();
    const result = await this.db.prepare(`
      UPDATE card_cache SET status = 'ready', short_title = ?, r2_key = ?, mime_type = 'image/png',
        created_at = ?, updated_at = ?, expires_at = ?, lease_until = NULL, builder_token = NULL
      WHERE cache_key = ? AND status = 'building' AND builder_token = ?
    `).bind(shortTitle, r2Key, now, now, now + this.ttlSeconds * 1000, identity.key, token).run();
    if (result.meta.changes !== 1) throw new Error("Cache build lease was lost");
  }

  async release(identity: CacheIdentity, token: string): Promise<void> {
    await this.db.prepare("DELETE FROM card_cache WHERE cache_key = ? AND status = 'building' AND builder_token = ?")
      .bind(identity.key, token).run();
  }
}
