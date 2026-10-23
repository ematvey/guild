-- A `send` from an ancestor used to write its status row into the caller's
-- chat while the child's result goes to the child's own parent chat, so the
-- row never received a result and counted as running forever. The row now
-- lands where the result lands; drop the rows written elsewhere.

DELETE FROM thread_events e
WHERE e.type IN ('child_spawned', 'child_closed')
  AND e.payload ? 'thread_id'
  AND EXISTS (
    SELECT 1
    FROM agent_threads t
    JOIN agent_threads p ON p.id = t.parent_thread_id
    WHERE t.id::text = e.payload->>'thread_id'
      AND p.chat_id <> e.chat_id
  );
