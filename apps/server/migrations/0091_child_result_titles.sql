-- Child result titles (docs/specs/2026-10-22-agent-to-agent.md, decision 37a).
--
-- A child_result written before the row carried its session name shows only
-- the agent name. The child thread's title is the session name its spawner
-- chose (or the task's first line), so this backfills it. Guarded so the file
-- can run twice.

UPDATE thread_events e
SET payload = e.payload || jsonb_build_object('title', t.title)
FROM agent_threads t
WHERE e.type = 'child_result'
  AND e.payload ->> 'thread_id' = t.id::text
  AND e.payload ->> 'title' IS NULL
  AND t.title <> '';
