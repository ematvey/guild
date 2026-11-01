-- A chat's title is what its tree and header name it by (the sidebar's name
-- for the chat). A title change moves the header of the chat itself, the
-- subtree of every ancestor chat, the header of every child chat (it names
-- the chat as its parent) and of every chat that started from it (it names
-- the chat as its origin). The archive and deletion flags keep their reach:
-- the thread list and the chat's own header.

CREATE OR REPLACE FUNCTION guild_notify_chat_flags() RETURNS trigger AS $$
DECLARE
  thread record;
  flags_moved boolean;
  title_moved boolean;
BEGIN
  flags_moved := NEW.archived_at IS DISTINCT FROM OLD.archived_at
                 OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at;
  title_moved := NEW.title IS DISTINCT FROM OLD.title;
  IF NOT flags_moved AND NOT title_moved THEN
    RETURN NULL;
  END IF;
  SELECT t.id, t.agent_id, t.user_id, t.type INTO thread
  FROM agent_threads t WHERE t.chat_id = NEW.id;
  IF NOT FOUND THEN
    PERFORM pg_notify('guild_subagent_tree', NEW.id::text);
    RETURN NULL;
  END IF;
  IF flags_moved AND thread.type = 'user' THEN
    PERFORM pg_notify('guild_agent_threads',
      json_build_object('org_id', NEW.org_id, 'user_id', thread.user_id, 'agent_id', thread.agent_id)::text);
  END IF;
  PERFORM pg_notify('guild_subagent_tree', NEW.id::text);
  IF title_moved THEN
    PERFORM guild_notify_thread_tree(thread.id);
    PERFORM pg_notify('guild_subagent_tree', o.chat_id::text)
    FROM agent_threads o WHERE o.origin_thread_id = thread.id;
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;
