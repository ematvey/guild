-- Agent and skill state NOTIFY: every write to an agent, its grants, its
-- threads, runs and routines, to the team memberships that decide team
-- visibility, and to the skill catalog tells the member-socket feed what
-- moved. The triggers sit on the tables so
-- no write path (routes, the runtime, the scheduler, the reconcile sweeps)
-- can change what a client shows without a push. Postgres folds identical
-- payloads within one transaction, so a bulk update notifies once per key.
--
--   guild_agents          {org_id}                    the org's agent lists
--   guild_agent_runs      {org_id, agent_id, run_id}  one run row
--   guild_agent_routines  {org_id, agent_id}          one agent's routines
--   guild_agent_threads   {org_id, user_id, agent_id} one user's thread list
--   guild_subagent_tree   chat_id                     a chat's tree and header
--   guild_skills          {org_id}                    the org's skill catalog

CREATE OR REPLACE FUNCTION guild_notify_agents() RETURNS trigger AS $$
DECLARE
  org uuid;
BEGIN
  IF TG_TABLE_NAME = 'agents' THEN
    org := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  ELSIF TG_TABLE_NAME = 'team_members' THEN
    SELECT t.org_id INTO org FROM teams t
     WHERE t.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.team_id ELSE NEW.team_id END;
  ELSE
    SELECT a.org_id INTO org FROM agents a
     WHERE a.id = CASE WHEN TG_OP = 'DELETE' THEN OLD.agent_id ELSE NEW.agent_id END;
  END IF;
  IF org IS NOT NULL THEN
    PERFORM pg_notify('guild_agents', json_build_object('org_id', org)::text);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_notify AFTER INSERT OR UPDATE OR DELETE ON agents
  FOR EACH ROW EXECUTE FUNCTION guild_notify_agents();
CREATE TRIGGER agent_grants_notify AFTER INSERT OR UPDATE OR DELETE ON agent_grants
  FOR EACH ROW EXECUTE FUNCTION guild_notify_agents();
CREATE TRIGGER agent_team_grants_notify AFTER INSERT OR UPDATE OR DELETE ON agent_team_grants
  FOR EACH ROW EXECUTE FUNCTION guild_notify_agents();
CREATE TRIGGER team_members_notify AFTER INSERT OR UPDATE OR DELETE ON team_members
  FOR EACH ROW EXECUTE FUNCTION guild_notify_agents();

CREATE OR REPLACE FUNCTION guild_notify_agent_run() RETURNS trigger AS $$
DECLARE
  org uuid;
BEGIN
  SELECT a.org_id INTO org FROM agents a WHERE a.id = NEW.agent_id;
  IF org IS NULL THEN
    RETURN NULL;
  END IF;
  PERFORM pg_notify('guild_agent_runs',
    json_build_object('org_id', org, 'agent_id', NEW.agent_id, 'run_id', NEW.id)::text);
  -- A routine lists its newest run: the routine list moves with it.
  IF NEW.routine_id IS NOT NULL THEN
    PERFORM pg_notify('guild_agent_routines',
      json_build_object('org_id', org, 'agent_id', NEW.agent_id)::text);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_runs_notify AFTER INSERT OR UPDATE ON agent_runs
  FOR EACH ROW EXECUTE FUNCTION guild_notify_agent_run();

CREATE OR REPLACE FUNCTION guild_notify_agent_routine() RETURNS trigger AS $$
DECLARE
  agent uuid;
  org uuid;
BEGIN
  agent := CASE WHEN TG_OP = 'DELETE' THEN OLD.agent_id ELSE NEW.agent_id END;
  SELECT a.org_id INTO org FROM agents a WHERE a.id = agent;
  IF org IS NOT NULL THEN
    PERFORM pg_notify('guild_agent_routines',
      json_build_object('org_id', org, 'agent_id', agent)::text);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_routines_notify AFTER INSERT OR UPDATE OR DELETE ON agent_routines
  FOR EACH ROW EXECUTE FUNCTION guild_notify_agent_routine();

-- The chats whose tree or header shows a thread's title or closed state:
-- the thread's own chat, every ancestor's chat, and its children's chats
-- (their header names it as the parent).
CREATE OR REPLACE FUNCTION guild_notify_thread_tree(thread uuid) RETURNS void AS $$
BEGIN
  PERFORM pg_notify('guild_subagent_tree', c.chat_id::text)
  FROM (
    WITH RECURSIVE up AS (
      SELECT id, parent_thread_id, chat_id FROM agent_threads WHERE id = thread
      UNION ALL
      SELECT t.id, t.parent_thread_id, t.chat_id
      FROM agent_threads t JOIN up ON t.id = up.parent_thread_id
    )
    SELECT chat_id FROM up
    UNION
    SELECT chat_id FROM agent_threads WHERE parent_thread_id = thread
  ) c;
END
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION guild_notify_agent_thread() RETURNS trigger AS $$
DECLARE
  row_ agent_threads%ROWTYPE;
  org uuid;
BEGIN
  IF TG_OP = 'DELETE' THEN
    row_ := OLD;
  ELSE
    row_ := NEW;
  END IF;
  SELECT c.org_id INTO org FROM chats c WHERE c.id = row_.chat_id;
  IF org IS NOT NULL AND row_.type = 'user' THEN
    PERFORM pg_notify('guild_agent_threads',
      json_build_object('org_id', org, 'user_id', row_.user_id, 'agent_id', row_.agent_id)::text);
  END IF;
  IF TG_OP = 'INSERT'
     OR (TG_OP = 'UPDATE' AND (NEW.title IS DISTINCT FROM OLD.title
                               OR NEW.closed_at IS DISTINCT FROM OLD.closed_at
                               OR NEW.agent_id IS DISTINCT FROM OLD.agent_id)) THEN
    PERFORM guild_notify_thread_tree(row_.id);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_threads_notify AFTER INSERT OR UPDATE OR DELETE ON agent_threads
  FOR EACH ROW EXECUTE FUNCTION guild_notify_agent_thread();

-- A chat's archive and deletion flags are thread facts: the thread list and
-- the chat's header follow them.
CREATE OR REPLACE FUNCTION guild_notify_chat_flags() RETURNS trigger AS $$
DECLARE
  thread record;
BEGIN
  IF NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at
     AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at THEN
    RETURN NULL;
  END IF;
  SELECT t.id, t.agent_id, t.user_id, t.type INTO thread
  FROM agent_threads t WHERE t.chat_id = NEW.id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF thread.type = 'user' THEN
    PERFORM pg_notify('guild_agent_threads',
      json_build_object('org_id', NEW.org_id, 'user_id', thread.user_id, 'agent_id', thread.agent_id)::text);
  END IF;
  PERFORM pg_notify('guild_subagent_tree', NEW.id::text);
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER chats_thread_flags_notify AFTER UPDATE ON chats
  FOR EACH ROW EXECUTE FUNCTION guild_notify_chat_flags();

-- The skill catalog: a publish, a gate flip, an unpublish, and every install,
-- uninstall or pin moves the catalog rows (versions, gates, install counts)
-- or the caller's own install list.
CREATE OR REPLACE FUNCTION guild_notify_skills() RETURNS trigger AS $$
DECLARE
  org uuid;
BEGIN
  IF TG_TABLE_NAME = 'registry_items' THEN
    IF (CASE WHEN TG_OP = 'DELETE' THEN OLD.kind ELSE NEW.kind END) <> 'skill' THEN
      RETURN NULL;
    END IF;
  END IF;
  org := CASE WHEN TG_OP = 'DELETE' THEN OLD.org_id ELSE NEW.org_id END;
  PERFORM pg_notify('guild_skills', json_build_object('org_id', org)::text);
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER registry_items_skills_notify AFTER INSERT OR UPDATE OR DELETE ON registry_items
  FOR EACH ROW EXECUTE FUNCTION guild_notify_skills();
CREATE TRIGGER skill_installs_notify AFTER INSERT OR UPDATE OR DELETE ON skill_installs
  FOR EACH ROW EXECUTE FUNCTION guild_notify_skills();
