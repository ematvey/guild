CREATE TABLE IF NOT EXISTS integration_secrets (
    org_id UUID NOT NULL,
    integration TEXT NOT NULL,
    name TEXT NOT NULL,
    secret_enc TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, integration, name)
);
