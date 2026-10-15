-- Per-user key/value settings (e.g. the chat view mode). User-scoped
-- mirror of org_kv (0028).
CREATE TABLE IF NOT EXISTS user_kv (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
