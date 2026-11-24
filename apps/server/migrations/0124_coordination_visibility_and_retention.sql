ALTER TABLE agent_coordination_inputs
  DROP CONSTRAINT agent_coordination_inputs_user_id_fkey,
  ADD CONSTRAINT agent_coordination_inputs_user_id_fkey
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

CREATE INDEX agent_coordination_inputs_user_idx ON agent_coordination_inputs(user_id);
CREATE INDEX agent_coordination_reflection_pending_idx ON agent_coordination_inputs(agent_id, seq)
  WHERE delivered_at IS NOT NULL AND reflected_at IS NULL;
CREATE INDEX agent_coordination_reflected_content_idx ON agent_coordination_inputs(reflected_at, id)
  WHERE reflected_at IS NOT NULL AND content <> '';

UPDATE agent_threads SET type = 'user' WHERE execution_role IN ('coordinator', 'reflection');

-- Both the list query and its notifications use the same membership rule.
CREATE FUNCTION agent_display_thread(type text, internal boolean, parent_role text)
RETURNS boolean LANGUAGE sql IMMUTABLE AS $$
  SELECT NOT internal AND (type = 'user' OR COALESCE(parent_role = 'coordinator', false))
$$;

CREATE OR REPLACE FUNCTION notify_coordination_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE node agent_threads%ROWTYPE; parent_agent uuid; parent_role text; chat record;
BEGIN
  IF TG_TABLE_NAME = 'chats' THEN
    IF NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at
       AND NEW.deleted_at IS NOT DISTINCT FROM OLD.deleted_at
       AND NEW.title IS NOT DISTINCT FROM OLD.title
       AND NEW.internal IS NOT DISTINCT FROM OLD.internal THEN RETURN NULL; END IF;
    SELECT * INTO node FROM agent_threads WHERE chat_id = NEW.id;
  ELSIF TG_OP = 'DELETE' THEN
    node := OLD;
  ELSE
    node := NEW;
  END IF;
  IF node.id IS NULL THEN RETURN NULL; END IF;
  SELECT p.agent_id, p.execution_role INTO parent_agent, parent_role
    FROM agent_threads p WHERE p.id = node.parent_thread_id;
  SELECT org_id, internal INTO chat FROM chats WHERE id = node.chat_id;
  IF NOT FOUND OR NOT agent_display_thread(node.type, chat.internal, parent_role) THEN RETURN NULL; END IF;
  PERFORM pg_notify('guild_agent_threads',
    json_build_object('org_id',chat.org_id,'user_id',node.user_id,'agent_id',node.agent_id)::text);
  IF parent_role = 'coordinator' AND parent_agent <> node.agent_id THEN
    PERFORM pg_notify('guild_agent_threads',
      json_build_object('org_id',chat.org_id,'user_id',node.user_id,'agent_id',parent_agent)::text);
  END IF;
  RETURN NULL;
END $$;

DROP TRIGGER coordination_task_notify ON agent_threads;
CREATE TRIGGER coordination_task_notify AFTER INSERT OR UPDATE OR DELETE ON agent_threads
  FOR EACH ROW EXECUTE FUNCTION notify_coordination_task();
CREATE TRIGGER coordination_chat_notify AFTER UPDATE ON chats
  FOR EACH ROW EXECUTE FUNCTION notify_coordination_task();
