-- Per-org key/value settings (e.g. the admin-configured assistant system
-- prompt). Org-scoped mirror of server_kv (0015).
CREATE TABLE IF NOT EXISTS org_kv (
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (org_id, key)
);
