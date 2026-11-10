-- Access (docs/domain/002-access.md, "Access"): one list per item of who may
-- reach it and how. An item's `visibility = 'org'` is the "everyone" entry;
-- named Members and Teams are rows here, each with a level. Agents and Apps
-- store the same shape under their own tables, so one predicate, one wire
-- shape and one route serve both. `read` sees and uses the item; `edit`
-- manages it.
--
-- The old agent_grants / agent_team_grants tables become agent_access: their
-- `user` role was the only one read, and it becomes `read`; `editor` becomes
-- `edit`; any other stored role granted nothing and is dropped. `team` is no
-- longer a visibility: team rows grant access wherever they exist, and a
-- `team` row on an agent with `private` visibility keeps granting.

CREATE TABLE IF NOT EXISTS agent_access (
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    level TEXT NOT NULL CHECK (level IN ('read', 'edit')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((user_id IS NULL) <> (team_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_access_user_idx ON agent_access (agent_id, user_id)
    WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS agent_access_team_idx ON agent_access (agent_id, team_id)
    WHERE team_id IS NOT NULL;

INSERT INTO agent_access (agent_id, user_id, level)
    SELECT agent_id, user_id, CASE WHEN role = 'editor' THEN 'edit' ELSE 'read' END
      FROM agent_grants WHERE role IN ('owner', 'editor', 'user', 'viewer')
    ON CONFLICT DO NOTHING;

INSERT INTO agent_access (agent_id, team_id, level)
    SELECT agent_id, team_id, CASE WHEN role = 'editor' THEN 'edit' ELSE 'read' END
      FROM agent_team_grants WHERE role IN ('editor', 'user', 'viewer')
    ON CONFLICT DO NOTHING;

DROP TRIGGER IF EXISTS agent_grants_notify ON agent_grants;
DROP TRIGGER IF EXISTS agent_team_grants_notify ON agent_team_grants;
DROP TABLE IF EXISTS agent_grants;
DROP TABLE IF EXISTS agent_team_grants;

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_visibility_check;
UPDATE agents SET visibility = 'private' WHERE visibility = 'team';
ALTER TABLE agents ADD CONSTRAINT agents_visibility_check CHECK (visibility IN ('private', 'org'));

CREATE TABLE IF NOT EXISTS app_access (
    app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    team_id UUID REFERENCES teams(id) ON DELETE CASCADE,
    level TEXT NOT NULL CHECK (level IN ('read', 'edit')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK ((user_id IS NULL) <> (team_id IS NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS app_access_user_idx ON app_access (app_id, user_id)
    WHERE user_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS app_access_team_idx ON app_access (app_id, team_id)
    WHERE team_id IS NOT NULL;

-- A grant change repaints the lists that apply the predicate: the org's agent
-- list for agent_access, every member's app list for app_access. A Team
-- membership change does the same for both.
CREATE TRIGGER agent_access_notify AFTER INSERT OR UPDATE OR DELETE ON agent_access
  FOR EACH ROW EXECUTE FUNCTION guild_notify_agents();

CREATE OR REPLACE FUNCTION guild_notify_app_access() RETURNS trigger AS $$
DECLARE
  org UUID;
  app UUID;
BEGIN
  app := CASE WHEN TG_OP = 'DELETE' THEN OLD.app_id ELSE NEW.app_id END;
  SELECT a.org_id INTO org FROM apps a WHERE a.id = app;
  IF org IS NOT NULL THEN
    PERFORM pg_notify('guild_apps', json_build_object('org_id', org)::text);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER app_access_notify AFTER INSERT OR UPDATE OR DELETE ON app_access
  FOR EACH ROW EXECUTE FUNCTION guild_notify_app_access();

CREATE OR REPLACE FUNCTION guild_notify_team_apps() RETURNS trigger AS $$
DECLARE
  org UUID;
BEGIN
  SELECT t.org_id INTO org FROM teams t
   WHERE t.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.team_id ELSE NEW.team_id END;
  IF org IS NOT NULL THEN
    PERFORM pg_notify('guild_apps', json_build_object('org_id', org)::text);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER team_members_apps_notify AFTER INSERT OR UPDATE OR DELETE ON team_members
  FOR EACH ROW EXECUTE FUNCTION guild_notify_team_apps();
