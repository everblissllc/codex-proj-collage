CREATE TABLE IF NOT EXISTS card_cache (
  cache_key TEXT PRIMARY KEY,
  store TEXT NOT NULL,
  product_id TEXT NOT NULL,
  short_title TEXT,
  r2_key TEXT,
  mime_type TEXT,
  status TEXT NOT NULL CHECK (status IN ('building', 'ready')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  expires_at INTEGER,
  last_accessed_at INTEGER,
  hit_count INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  builder_token TEXT
);

CREATE INDEX IF NOT EXISTS card_cache_status_lease_idx ON card_cache(status, lease_until);
