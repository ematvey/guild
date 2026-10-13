-- integrations (0018) and integration_secrets (0029) declared org_id without
-- a foreign key; deleting an org would strand their rows.
ALTER TABLE integrations
  ADD CONSTRAINT integrations_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE;

ALTER TABLE integration_secrets
  ADD CONSTRAINT integration_secrets_org_id_fkey
  FOREIGN KEY (org_id) REFERENCES orgs(id) ON DELETE CASCADE;
