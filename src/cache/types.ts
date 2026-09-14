import type { CardImage } from "../rendering/types";
import type { StoreId } from "../types";

export type CacheIdentity = {
  key: string;
  keyPrefix: string;
  store: StoreId;
  productId: string;
  r2Prefix: string;
};

export type CacheLookup =
  | { kind: "hit"; shortTitle: string; card: CardImage; ageSeconds: number; hitCount: number }
  | { kind: "miss"; reason: "missing" | "expired" }
  | { kind: "building"; leaseUntil: number }
  | { kind: "corrupt"; updatedAt: number; r2Key: string | null };

export interface CardCache {
  lookup(identity: CacheIdentity, requestId: string): Promise<CacheLookup>;
  claim(identity: CacheIdentity, corrupt?: { updatedAt: number; r2Key: string | null }): Promise<string | null>;
  store(identity: CacheIdentity, token: string, shortTitle: string, card: CardImage): Promise<void>;
  release(identity: CacheIdentity, token: string): Promise<void>;
}
