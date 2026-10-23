-- Child result labels (docs/specs/2026-10-22-agent-to-agent.md, decision 36).
--
-- A child_result written before the row carried its chat and agent has
-- neither, so the pinned subagent row shows "Subagent" and cannot navigate.
-- Both values live on the child thread; this backfills every old event from
-- it. The guard keeps the file runnable twice.

UPDATE thread_events e
SET payload = e.payload
  || jsonb_build_object('chat_id', t.chat_id::text)
  || jsonb_build_object('agent_name', a.name)
FROM agent_threads t
JOIN agents a ON a.id = t.agent_id
WHERE e.type = 'child_result'
  AND e.payload ->> 'thread_id' = t.id::text
  AND (e.payload ->> 'chat_id' IS NULL OR e.payload ->> 'agent_name' IS NULL);
