CREATE TABLE provider_keys (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id),
  provider TEXT NOT NULL,
  base_url TEXT NOT NULL,
  encrypted_key TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (org_id, provider)
);

CREATE TABLE model_routes (
  org_id UUID NOT NULL REFERENCES orgs(id),
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT true,
  price_per_mtok_in_usd DOUBLE PRECISION NOT NULL,
  price_per_mtok_out_usd DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (org_id, model)
);
