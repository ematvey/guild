-- Release artifact signatures (ed25519 over the sha256 digest) plus the
-- server key/value table holding the auto-generated signing seed.
CREATE TABLE IF NOT EXISTS server_kv (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
ALTER TABLE releases ADD COLUMN IF NOT EXISTS signature TEXT NOT NULL DEFAULT '';
