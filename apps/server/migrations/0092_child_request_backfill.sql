-- Child chats created before a spawn wrote its request into the child
-- transcript hold only the agent's answer. Put the request back: the first
-- user input from the chat's durable log, inserted ahead of the events the
-- chat already has. `seq` is a global sequence, so a backfilled row takes a
-- negative value — it sorts before every generated seq for that chat and
-- cannot collide with one.
--
-- The durable log is owned by the Rust store and is absent from a fresh
-- platform schema, so the backfill is a no-op until those tables exist.
DO $migration$
BEGIN
  IF to_regclass('public.chat_conversations') IS NULL
     OR to_regclass('public.entries') IS NULL
     OR to_regclass('public.agent_threads') IS NULL THEN
    RETURN;
  END IF;

  EXECUTE $backfill$
    WITH child AS (
      SELECT t.chat_id
      FROM agent_threads t
      WHERE t.kind = 'delegated'
        AND NOT EXISTS (
          SELECT 1
          FROM thread_events e
          WHERE e.chat_id = t.chat_id AND e.type = 'user_message'
        )
    ),
    first_user AS (
      SELECT
        c.chat_id,
        (
          SELECT e.record::jsonb #>> '{model,0,content}'
          FROM chat_conversations cc
          JOIN entries e ON e.conversation_id = cc.conversation_id
          WHERE cc.chat_id = c.chat_id
            AND e.record::jsonb #>> '{kind}' = 'pi.user'
            AND jsonb_typeof(e.record::jsonb #> '{model,0,content}') = 'string'
          ORDER BY e.id
          LIMIT 1
        ) AS content
      FROM child c
    )
    INSERT INTO thread_events (id, chat_id, seq, type, payload, created_at)
    SELECT
      gen_random_uuid(),
      f.chat_id,
      -row_number() OVER (ORDER BY f.chat_id),
      'user_message',
      jsonb_build_object('type', 'user_message', 'content', f.content, 'attachments', '[]'::jsonb),
      now()
    FROM first_user f
    WHERE f.content IS NOT NULL AND f.content <> ''
  $backfill$;
END
$migration$;
