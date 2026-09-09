-- Org event log (spec §4.6/§4.8): emitted server-side, fanned out to
-- subscribed clients over Postgres LISTEN/NOTIFY + SSE.
CREATE TABLE IF NOT EXISTS events (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_org_created_idx ON events (org_id, created_at DESC);
