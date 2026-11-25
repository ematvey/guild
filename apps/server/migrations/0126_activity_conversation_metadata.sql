-- A Conversation's header and related Threads change independently of
-- committed messages and Run statuses.
CREATE FUNCTION guild_notify_activity_thread(node agent_threads) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('guild_activity_conversation', affected.chat_id::text)
  FROM (
    SELECT node.chat_id
    UNION
    SELECT chat_id FROM agent_threads
    WHERE id = node.parent_thread_id
       OR parent_thread_id = node.id
       OR (node.execution_role IN ('coordinator', 'reflection') AND agent_id = node.agent_id)
  ) affected;
END
$$;

CREATE FUNCTION guild_activity_thread_metadata() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND
    (OLD.title, OLD.parent_thread_id, OLD.agent_id, OLD.execution_role, OLD.type)
    IS NOT DISTINCT FROM
    (NEW.title, NEW.parent_thread_id, NEW.agent_id, NEW.execution_role, NEW.type)
  THEN
    RETURN NULL;
  END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND
    (OLD.parent_thread_id, OLD.agent_id, OLD.execution_role) IS DISTINCT FROM
    (NEW.parent_thread_id, NEW.agent_id, NEW.execution_role))
  THEN
    PERFORM guild_notify_activity_thread(OLD);
  END IF;
  IF TG_OP <> 'DELETE' THEN
    PERFORM guild_notify_activity_thread(NEW);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER activity_thread_metadata
AFTER INSERT OR DELETE OR UPDATE OF title, parent_thread_id, agent_id, execution_role, type ON agent_threads
FOR EACH ROW EXECUTE FUNCTION guild_activity_thread_metadata();

CREATE FUNCTION guild_activity_chat_metadata() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  node agent_threads;
BEGIN
  SELECT * INTO node FROM agent_threads WHERE chat_id = NEW.id;
  IF FOUND THEN
    PERFORM guild_notify_activity_thread(node);
  ELSE
    PERFORM pg_notify('guild_activity_conversation', NEW.id::text);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER activity_chat_metadata
AFTER UPDATE OF title, archived_at, deleted_at, internal ON chats
FOR EACH ROW WHEN (
  (OLD.title, OLD.archived_at, OLD.deleted_at, OLD.internal)
  IS DISTINCT FROM
  (NEW.title, NEW.archived_at, NEW.deleted_at, NEW.internal)
)
EXECUTE FUNCTION guild_activity_chat_metadata();

CREATE FUNCTION guild_activity_agent_metadata() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('guild_activity_conversation', chat_id::text)
  FROM agent_threads WHERE agent_id = NEW.id;
  RETURN NULL;
END
$$;

CREATE TRIGGER activity_agent_metadata
AFTER UPDATE OF name ON agents
FOR EACH ROW WHEN (OLD.name IS DISTINCT FROM NEW.name)
EXECUTE FUNCTION guild_activity_agent_metadata();
