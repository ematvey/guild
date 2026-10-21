-- Threads are private to the user they belong to
-- (docs/specs/2026-10-21-unified-threads.md, decisions 4, 5, 9).
--
-- A thread now carries the user on whose behalf it exists: the caller for a
-- user message, the routine's creator for a scheduled run, the parent's user
-- for a delegation. Access is scoped to that user, so sharing an agent shares
-- its workspace, never its conversations.
--
-- Also drops the org agent cap: agent count is no longer limited.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS is_personal BOOLEAN NOT NULL DEFAULT false;

-- One personal agent per user, among live agents.
CREATE UNIQUE INDEX IF NOT EXISTS agents_one_personal_idx
    ON agents (owner_user_id) WHERE is_personal AND status <> 'deleted';

ALTER TABLE agent_threads ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;

-- Existing threads take the creator from their chat row; the agent owner is
-- the fallback for a thread whose chat row is gone.
UPDATE agent_threads t SET user_id = c.user_id
FROM chats c WHERE c.id = t.chat_id AND t.user_id IS NULL;
UPDATE agent_threads t SET user_id = a.owner_user_id
FROM agents a WHERE a.id = t.agent_id AND t.user_id IS NULL;
ALTER TABLE agent_threads ALTER COLUMN user_id SET NOT NULL;

-- A shared agent gives each user their own default thread.
DROP INDEX IF EXISTS agent_threads_one_default_idx;
CREATE UNIQUE INDEX agent_threads_one_default_idx
    ON agent_threads (agent_id, user_id) WHERE kind = 'default';
CREATE INDEX IF NOT EXISTS agent_threads_user_activity_idx
    ON agent_threads (user_id, last_activity_at DESC);

-- A routine belongs to the user who created it; its runs and threads are
-- private to that user.
ALTER TABLE agent_routines ADD COLUMN IF NOT EXISTS created_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL;
UPDATE agent_routines r SET created_by_user_id = a.owner_user_id
FROM agents a WHERE a.id = r.agent_id AND r.created_by_user_id IS NULL;

-- Every run records the user on whose behalf it happens.
ALTER TABLE agent_runs ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL;
UPDATE agent_runs r SET user_id = t.user_id
FROM agent_threads t WHERE t.id = r.thread_id AND r.user_id IS NULL;
UPDATE agent_runs r SET user_id = ar.created_by_user_id
FROM agent_routines ar WHERE ar.id = r.routine_id AND r.user_id IS NULL;
UPDATE agent_runs r SET user_id = a.owner_user_id
FROM agents a WHERE a.id = r.agent_id AND r.user_id IS NULL;

CREATE INDEX IF NOT EXISTS agent_runs_user_activity_idx ON agent_runs (user_id, created_at DESC);
