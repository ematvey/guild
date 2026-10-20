-- The default thread is the agent's primary conversation, not a transcript
-- titled from its first message. Name it once; a manual rename still wins.
UPDATE agent_threads
SET title = 'Main thread'
WHERE kind = 'default' AND title_locked = false AND title <> 'Main thread';

UPDATE chats c
SET title = 'Main thread'
FROM agent_threads t
WHERE t.chat_id = c.id
  AND t.kind = 'default'
  AND t.title_locked = false
  AND c.title IS DISTINCT FROM 'Main thread';
