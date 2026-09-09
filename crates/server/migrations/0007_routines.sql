CREATE TABLE routines (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  created_by UUID REFERENCES users(id),
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  trigger_kind TEXT NOT NULL CHECK (trigger_kind IN ('webhook','interval')),
  trigger_config JSONB NOT NULL DEFAULT '{}',
  prompt TEXT NOT NULL,
  model TEXT NOT NULL,
  allowed_tools JSONB NOT NULL DEFAULT '["http_call","storage_put"]',
  webhook_token TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, slug)
);

CREATE TABLE routine_runs (
  id UUID PRIMARY KEY,
  routine_id UUID NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
  trigger TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running','succeeded','failed')),
  summary TEXT,
  error TEXT,
  started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
