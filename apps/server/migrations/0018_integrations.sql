-- Admin-configured integration plugins (server-side chat tools), per org.
CREATE TABLE IF NOT EXISTS integrations (
    org_id UUID NOT NULL,
    name TEXT NOT NULL,
    config JSONB NOT NULL DEFAULT '{}'::jsonb,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, name)
);
