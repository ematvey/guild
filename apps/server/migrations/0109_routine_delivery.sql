-- Routine delivery: where a routine run's send_message lands.
--   thread    one conversation per routine and user; every delivery is
--             appended to it (the default)
--   new_chat  every delivery opens its own conversation
-- agent_threads.routine_id marks a user-visible thread as a routine's output
-- (the sidebar's routine mark, and the feed thread lookup in thread mode).
ALTER TABLE agent_routines
    ADD COLUMN IF NOT EXISTS delivery TEXT NOT NULL DEFAULT 'thread'
        CHECK (delivery IN ('thread', 'new_chat'));

ALTER TABLE agent_threads
    ADD COLUMN IF NOT EXISTS routine_id UUID REFERENCES agent_routines(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS agent_threads_routine_idx
    ON agent_threads (routine_id, user_id) WHERE routine_id IS NOT NULL;

-- Threads a routine run already opened with send_message carry the routine
-- of the run behind them.
UPDATE agent_threads t
SET routine_id = (
    SELECT rn.routine_id FROM agent_runs rn
    WHERE rn.thread_id = t.origin_thread_id AND rn.routine_id IS NOT NULL
    ORDER BY rn.created_at DESC LIMIT 1)
FROM agent_threads o
WHERE o.id = t.origin_thread_id
  AND o.type = 'routine'
  AND t.type = 'user'
  AND t.routine_id IS NULL;

-- The one thread per (routine, user) that thread-mode deliveries append to.
-- A feed whose chat the user archives or deletes is retired (flag cleared)
-- and the next delivery opens a new one.
ALTER TABLE agent_threads
    ADD COLUMN IF NOT EXISTS routine_feed BOOLEAN NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS agent_threads_one_routine_feed_idx
    ON agent_threads (routine_id, user_id) WHERE routine_feed;
