-- Agent-to-agent backfill (docs/plans/2026-10-22-agent-to-agent.md, WP6).
--
-- The schema in 0087 adds the tree edge, the delivery columns and the
-- attachment author columns. This migration moves existing rows onto the new
-- model. Every statement is guarded so the file can run again without
-- changing rows that are already correct.
--
-- The platform migration runner wraps this file in one transaction. The
-- statements are grouped by concern, not by separate BEGIN/COMMIT blocks, so
-- a failure rolls the whole file back.

-- 1. Existing delegated threads are labelled routine_run. A child run has a
--    parent_run_id and trigger = 'delegation'; a genuine routine thread has
--    neither. Only relabel threads that a delegation run points at.
UPDATE agent_threads t
SET kind = 'delegated'
WHERE t.kind = 'routine_run'
  AND EXISTS (
      SELECT 1
      FROM agent_runs r
      WHERE r.thread_id = t.id
        AND r.parent_run_id IS NOT NULL
        AND r.trigger = 'delegation'
  );

-- 2. Rebuild the tree edge from the parent run, then recompute every depth
--    from the roots. A single pass over the child runs is not enough when a
--    grandchild's parent is also a child.
WITH child_parent AS (
    SELECT DISTINCT ON (r.thread_id)
           r.thread_id AS child_thread_id,
           p.thread_id AS parent_thread_id
    FROM agent_runs r
    JOIN agent_runs p ON p.id = r.parent_run_id
    WHERE r.trigger = 'delegation'
      AND r.parent_run_id IS NOT NULL
      AND r.thread_id IS NOT NULL
      AND p.thread_id IS NOT NULL
    ORDER BY r.thread_id, r.created_at ASC, r.id ASC
)
UPDATE agent_threads t
SET parent_thread_id = cp.parent_thread_id
FROM child_parent cp
WHERE t.id = cp.child_thread_id
  AND t.parent_thread_id IS DISTINCT FROM cp.parent_thread_id;

WITH RECURSIVE tree AS (
    SELECT id, 0 AS depth
    FROM agent_threads
    WHERE parent_thread_id IS NULL
    UNION ALL
    SELECT child.id, tree.depth + 1
    FROM agent_threads child
    JOIN tree ON child.parent_thread_id = tree.id
    WHERE tree.depth < 64
)
UPDATE agent_threads t
SET depth = tree.depth
FROM tree
WHERE t.id = tree.id;

-- 3. Bind old user uploads to the user_message event that lists them. The
--    payload carries attachment ids either as objects (current shape) or as
--    bare strings (old shape). The author is the chat owner. Rows with no
--    matching event keep NULL values; the report counts them.
WITH matched AS (
    SELECT a.id AS attachment_id,
           e.id AS event_id,
           c.user_id AS author_id
    FROM attachments a
    JOIN chats c ON c.id = a.chat_id
    JOIN LATERAL (
        SELECT e.id
        FROM thread_events e
        WHERE e.chat_id = a.chat_id
          AND e.type = 'user_message'
          AND EXISTS (
              SELECT 1
              FROM jsonb_array_elements(
                       CASE
                           WHEN jsonb_typeof(e.payload -> 'attachments') = 'array'
                               THEN e.payload -> 'attachments'
                           ELSE '[]'::jsonb
                       END
                   ) AS item
              WHERE (jsonb_typeof(item) = 'object' AND item ->> 'id' = a.id::text)
                 OR (jsonb_typeof(item) = 'string' AND item = to_jsonb(a.id::text))
          )
        ORDER BY e.seq ASC
        LIMIT 1
    ) e ON true
    WHERE a.event_id IS NULL
      AND (a.author_kind IS NULL OR a.author_kind = 'user')
)
UPDATE attachments a
SET event_id = matched.event_id,
    author_kind = 'user',
    author_id = matched.author_id
FROM matched
WHERE a.id = matched.attachment_id;

-- 4. Move delegation artifact declarations into attachments. The bytes stay
--    where they were; the row keeps the workspace path in source_path. An
--    existing agent attachment with the same chat, path and size is the same
--    file and is not inserted twice. event_id stays NULL until a turn event
--    publishes the attachment. The table is gone after the first run, so the
--    copy runs only when the table exists.
DO $do$
BEGIN
    IF to_regclass('public.agent_delegation_artifacts') IS NOT NULL THEN
        EXECUTE $sql$
            WITH artifacts AS (
                SELECT DISTINCT ON (c.id, d.path, d.size)
                       d.id,
                       d.path,
                       d.size,
                       d.agent_id,
                       d.created_at,
                       c.org_id,
                       c.id AS chat_id,
                       regexp_replace(d.path, '^.*/', '') AS filename
                FROM agent_delegation_artifacts d
                JOIN agent_runs pr ON pr.id = d.parent_run_id
                JOIN agent_threads pt ON pt.id = pr.thread_id
                JOIN chats c ON c.id = pt.chat_id
                ORDER BY c.id, d.path, d.size, d.created_at ASC, d.id ASC
            )
            INSERT INTO attachments (
                id, org_id, chat_id, filename, content_type, size_bytes, object_key,
                event_id, author_kind, author_id, source_path, created_at
            )
            SELECT a.id,
                   a.org_id,
                   a.chat_id,
                   a.filename,
                   'application/octet-stream',
                   a.size,
                   'attachments/' || a.org_id::text || '/' || a.id::text || '/' || a.filename,
                   NULL,
                   'agent',
                   a.agent_id,
                   a.path,
                   a.created_at
            FROM artifacts a
            WHERE NOT EXISTS (
                SELECT 1
                FROM attachments x
                WHERE x.chat_id = a.chat_id
                  AND x.author_kind = 'agent'
                  AND x.source_path = a.path
                  AND x.size_bytes = a.size
            )
            ON CONFLICT DO NOTHING
        $sql$;
    END IF;
END
$do$;

DROP TABLE IF EXISTS agent_delegation_artifacts;

-- 5. Remove the retired tools from every stored allowlist. send_file stays.
UPDATE agents
SET tools = COALESCE((
        SELECT jsonb_agg(entry.value ORDER BY entry.ord)
        FROM jsonb_array_elements(agents.tools) WITH ORDINALITY AS entry(value, ord)
        WHERE entry.value NOT IN ('"delegate"'::jsonb, '"release_artifacts"'::jsonb)
    ), '[]'::jsonb),
    updated_at = now()
WHERE jsonb_typeof(agents.tools) = 'array'
  AND (agents.tools @> '["delegate"]'::jsonb
       OR agents.tools @> '["release_artifacts"]'::jsonb);

-- 6. Make the attachment author columns required only when the backfill left
--    no gaps. A table with no rows is not evidence that the code is ready for
--    NOT NULL: pending agent attachments are inserted with event_id NULL and
--    published at turn end, so an empty database keeps the columns nullable.
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM attachments)
       AND NOT EXISTS (
           SELECT 1
           FROM attachments
           WHERE event_id IS NULL
              OR author_kind IS NULL
              OR author_id IS NULL
       )
    THEN
        ALTER TABLE attachments ALTER COLUMN event_id SET NOT NULL;
        ALTER TABLE attachments ALTER COLUMN author_kind SET NOT NULL;
        ALTER TABLE attachments ALTER COLUMN author_id SET NOT NULL;
    END IF;
END $$;
