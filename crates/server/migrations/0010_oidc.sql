-- OIDC SSO configuration, one per org (spec §4.1/§5).
CREATE TABLE IF NOT EXISTS oidc_configs (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL UNIQUE REFERENCES orgs(id) ON DELETE CASCADE,
    issuer TEXT NOT NULL,
    client_id TEXT NOT NULL,
    encrypted_client_secret TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
