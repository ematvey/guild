-- Integrations become id-addressed db objects: every configured
-- integration (built-in connector or registry MCP plugin) is a row with a
-- stable id. The connector slug stays unique per org — one configuration
-- per connector — so the resolver and tool namespacing are unchanged.
ALTER TABLE integrations ADD COLUMN id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE integrations DROP CONSTRAINT integrations_pkey;
ALTER TABLE integrations ADD PRIMARY KEY (id);
ALTER TABLE integrations ADD CONSTRAINT integrations_org_name_unique UNIQUE (org_id, name);
