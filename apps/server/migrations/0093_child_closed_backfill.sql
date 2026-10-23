-- Two rows the earlier code could not describe:
--
-- 1. A child closed before the close route wrote `child_closed` stays "running"
--    forever in the parent's strip, because a closed child's result is dropped
--    and nothing else marks it. Append the missing event, once per closed
--    child that has none.
-- 2. A `child_result` written before the event carried `started_at` leaves the
--    row with no start, so the client shows 0s. Fill it from the run.

DO $migration$
BEGIN
  IF to_regclass('public.thread_events') IS NULL
     OR to_regclass('public.agent_threads') IS NULL THEN
    RETURN;
  END IF;

  -- 1. The closed marker for children that were closed without one.
  INSERT INTO thread_events (id, chat_id, type, payload, created_at)
  SELECT
    gen_random_uuid(),
    p.chat_id,
    'child_closed',
    jsonb_build_object('type', 'child_closed', 'thread_id', c.id),
    c.closed_at
  FROM agent_threads c
  JOIN agent_threads p ON p.id = c.parent_thread_id
  WHERE c.kind = 'delegated'
    AND c.closed_at IS NOT NULL
    AND NOT EXISTS (
      SELECT 1
      FROM thread_events e
      WHERE e.chat_id = p.chat_id
        AND e.type = 'child_closed'
        AND e.payload->>'thread_id' = c.id::text
    );

  -- 2. The run's start on results that predate the field.
  IF to_regclass('public.agent_runs') IS NOT NULL THEN
    UPDATE thread_events e
    SET payload = e.payload || jsonb_build_object(
      'started_at',
      to_char(r.started_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
    FROM agent_runs r
    WHERE e.type = 'child_result'
      AND e.payload->>'run_id' = r.id::text
      AND e.payload->>'started_at' IS NULL
      AND r.started_at IS NOT NULL;
  END IF;
END
$migration$;
