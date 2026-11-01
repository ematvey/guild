-- A chat's tree and header name the agent of every thread they show, so an
-- agent rename moves the tree of every chat that holds one of its threads:
-- each thread's own chat, its ancestors' chats (their subtree lists it) and
-- its children's chats (guild_notify_thread_tree's reach).

CREATE OR REPLACE FUNCTION guild_notify_agent_name() RETURNS trigger AS $$
DECLARE
  thread uuid;
BEGIN
  IF NEW.name IS NOT DISTINCT FROM OLD.name THEN
    RETURN NULL;
  END IF;
  FOR thread IN SELECT t.id FROM agent_threads t WHERE t.agent_id = NEW.id LOOP
    PERFORM guild_notify_thread_tree(thread);
  END LOOP;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER agents_name_tree_notify AFTER UPDATE OF name ON agents
  FOR EACH ROW EXECUTE FUNCTION guild_notify_agent_name();
