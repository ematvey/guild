-- Main threads that never held a turn are removed. Reading an agent's
-- threads used to create the reader's Main thread, so admins browsing other
-- Members' agents collected empty ones in their thread lists. A thread with
-- any event, run, durable conversation or child thread stays. Deleting the
-- chat removes its agent_threads row and the rest of its rows by cascade.
DELETE FROM chats c
USING agent_threads t
WHERE t.chat_id = c.id
  AND t.is_default
  AND NOT EXISTS (SELECT 1 FROM thread_events e WHERE e.chat_id = t.chat_id)
  AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.thread_id = t.id)
  AND NOT EXISTS (SELECT 1 FROM chat_conversations v WHERE v.chat_id = t.chat_id)
  AND NOT EXISTS (
    SELECT 1 FROM agent_threads k WHERE k.parent_thread_id = t.id OR k.origin_thread_id = t.id
  );
