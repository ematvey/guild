CREATE TABLE registry_items (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  kind TEXT NOT NULL CHECK (kind IN ('skill','mcp','integration')),
  slug TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  latest_version TEXT,
  review_status TEXT NOT NULL DEFAULT 'draft' CHECK (review_status IN ('draft','approved')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, kind, slug)
);

CREATE TABLE registry_versions (
  id UUID PRIMARY KEY,
  item_id UUID NOT NULL REFERENCES registry_items(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  manifest JSONB NOT NULL,
  object_key TEXT NOT NULL,
  published_by UUID REFERENCES users(id),
  published_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (item_id, version)
);
