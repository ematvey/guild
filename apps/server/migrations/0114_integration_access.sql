-- Integration access: an Integration's audience (who may attach it to an
-- Agent, and at what class ceiling) and each Agent's explicit Integration
-- list. An Agent's list decides what its Turns see; the audience decides who
-- may add an entry. docs/specs/2026-11-04-integration-access.md.

ALTER TABLE integrations
  ADD COLUMN audience TEXT NOT NULL DEFAULT 'admins'
    CHECK (audience IN ('org', 'team', 'admins')),
  ADD COLUMN org_ceiling TEXT NOT NULL DEFAULT 'read'
    CHECK (org_ceiling IN ('read', 'write'));

-- Existing rows keep today's reach: every member, at the class the member
-- role had (a stored `tool_policy.member`, else read). An empty member
-- policy allowed nothing, which is the `admins` audience.
UPDATE integrations SET
  audience = CASE
    WHEN jsonb_typeof(config->'tool_policy'->'member') = 'array'
         AND jsonb_array_length(config->'tool_policy'->'member') = 0 THEN 'admins'
    ELSE 'org' END,
  org_ceiling = CASE
    WHEN jsonb_typeof(config->'tool_policy'->'member') = 'array'
         AND (config->'tool_policy'->'member') ?| ARRAY['write', 'admin'] THEN 'write'
    ELSE 'read' END;
UPDATE integrations SET config = config - 'tool_policy' WHERE config ? 'tool_policy';

CREATE TABLE integration_grants (
  integration_id UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES orgs(id),
  team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  ceiling TEXT NOT NULL CHECK (ceiling IN ('read', 'write')),
  PRIMARY KEY (integration_id, team_id)
);

CREATE TABLE agent_integrations (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  integration_id UUID NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
  ceiling TEXT NOT NULL CHECK (ceiling IN ('read', 'write', 'admin')),
  added_by UUID REFERENCES users(id) ON DELETE SET NULL,
  added_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, integration_id)
);
CREATE INDEX agent_integrations_integration_idx ON agent_integrations (integration_id);

-- Today's reach becomes explicit entries. An `all` Agent lists every
-- enabled Integration; a `selected` Agent lists the Integrations whose tools
-- it selected. A personal Agent's entry takes its owner's role; a shared
-- Agent's entry takes what a member got, so nobody gains a class.
INSERT INTO agent_integrations (agent_id, integration_id, ceiling, added_by)
SELECT a.id, i.id,
       CASE WHEN a.is_personal AND u.role = 'admin' THEN 'admin' ELSE i.org_ceiling END,
       a.owner_user_id
  FROM agents a
  JOIN integrations i ON i.org_id = a.org_id
  JOIN users u ON u.id = a.owner_user_id
 WHERE a.status <> 'deleted'
   AND (i.audience <> 'admins' OR (a.is_personal AND u.role = 'admin'))
   AND (
     (a.tools_mode = 'all' AND i.enabled)
     OR (a.tools_mode = 'selected' AND EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(a.tools) t(name)
            WHERE starts_with(t.name, i.name || '_')))
   )
ON CONFLICT DO NOTHING;

-- A `selected` Agent's tool list now names built-in and Trait tools only.
UPDATE agents a SET tools = COALESCE((
  SELECT jsonb_agg(t.name ORDER BY t.ord)
    FROM jsonb_array_elements_text(a.tools) WITH ORDINALITY t(name, ord)
   WHERE NOT EXISTS (SELECT 1 FROM integrations i
                      WHERE i.org_id = a.org_id AND starts_with(t.name, i.name || '_'))
), '[]'::jsonb)
 WHERE a.tools_mode = 'selected';

-- Every write that moves an Integration's audience, its grants or an
-- Agent's list moves the agent lists (their warnings) and each member's
-- attachable Integrations: one `guild_agents` notify.
CREATE OR REPLACE FUNCTION guild_notify_integration_access() RETURNS trigger AS $$
DECLARE
  org uuid;
BEGIN
  IF TG_TABLE_NAME = 'agent_integrations' THEN
    SELECT a.org_id INTO org FROM agents a
     WHERE a.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.agent_id ELSE NEW.agent_id END;
  ELSE
    org := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  END IF;
  IF org IS NOT NULL THEN
    PERFORM pg_notify('guild_agents', json_build_object('org_id', org)::text);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER integrations_access_notify AFTER INSERT OR DELETE OR UPDATE OF audience, org_ceiling, enabled, name
  ON integrations FOR EACH ROW EXECUTE FUNCTION guild_notify_integration_access();
CREATE TRIGGER integration_grants_notify AFTER INSERT OR UPDATE OR DELETE ON integration_grants
  FOR EACH ROW EXECUTE FUNCTION guild_notify_integration_access();
CREATE TRIGGER agent_integrations_notify AFTER INSERT OR UPDATE OR DELETE ON agent_integrations
  FOR EACH ROW EXECUTE FUNCTION guild_notify_integration_access();
