-- An Integration row is an instance of a catalog item. `kind` names the
-- plugin it instantiates (a built-in, an installed code plugin, or a
-- registry MCP server); `name` is the instance's own slug; `label` is the
-- name the admin gives it. Several instances of one kind coexist, each with
-- its own secrets, tool curation, audience and grants.

ALTER TABLE integrations ADD COLUMN IF NOT EXISTS kind TEXT;
UPDATE integrations SET kind = name WHERE kind IS NULL;
ALTER TABLE integrations ALTER COLUMN kind SET NOT NULL;
ALTER TABLE integrations ADD COLUMN IF NOT EXISTS label TEXT NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS integrations_org_kind_idx ON integrations (org_id, kind);
