-- An agents UPDATE that leaves the row as it was moves no agent list, so it
-- notifies no one: the update trigger fires only when a column changed.
-- Inserts and deletes keep notifying unconditionally.
DROP TRIGGER IF EXISTS agents_notify ON agents;

CREATE TRIGGER agents_notify AFTER INSERT OR DELETE ON agents
  FOR EACH ROW EXECUTE FUNCTION guild_notify_agents();

CREATE TRIGGER agents_update_notify AFTER UPDATE ON agents
  FOR EACH ROW WHEN (OLD.* IS DISTINCT FROM NEW.*) EXECUTE FUNCTION guild_notify_agents();
