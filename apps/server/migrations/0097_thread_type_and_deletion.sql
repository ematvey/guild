-- Threads carry three independent facts (PLAN 2026-10-27):
--   type       what the thread is: a user conversation, a subagent node, or
--              a routine run. It never changes for a thread's lifetime.
--   archived   the user hid it from the sidebar; it still resolves and can
--              be unarchived.
--   deleted    the user removed it; it drops out of every list.
-- `kind` mixed the type with the default-thread role ('default' vs 'thread'),
-- so it splits into `type` plus `is_default`.

ALTER TABLE agent_threads ADD COLUMN IF NOT EXISTS type TEXT;
ALTER TABLE agent_threads ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

UPDATE agent_threads
SET type = CASE
      WHEN kind = 'routine_run' THEN 'routine'
      WHEN kind = 'delegated' OR parent_thread_id IS NOT NULL THEN 'subagent'
      ELSE 'user'
    END,
    is_default = (kind = 'default')
WHERE type IS NULL;

ALTER TABLE agent_threads ALTER COLUMN type SET NOT NULL;
ALTER TABLE agent_threads DROP CONSTRAINT IF EXISTS agent_threads_type_check;
ALTER TABLE agent_threads ADD CONSTRAINT agent_threads_type_check
    CHECK (type IN ('user', 'subagent', 'routine'));

-- The default thread is the user's Main thread with that agent: one per
-- (agent, user), and only a user thread can be it.
DROP INDEX IF EXISTS agent_threads_one_default_idx;
CREATE UNIQUE INDEX IF NOT EXISTS agent_threads_one_default_idx
    ON agent_threads (agent_id, user_id) WHERE is_default;

ALTER TABLE agent_threads DROP CONSTRAINT IF EXISTS agent_threads_kind_check;
ALTER TABLE agent_threads DROP COLUMN kind;

-- Deletion is a flag, not a second archive: the row and its transcript stay.
ALTER TABLE chats ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS chats_deleted_idx
    ON chats (org_id, user_id, deleted_at) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS agent_threads_user_type_activity_idx
    ON agent_threads (user_id, type, last_activity_at DESC);
