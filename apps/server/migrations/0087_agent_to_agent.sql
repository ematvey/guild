-- Agent-to-agent tree (docs/specs/2026-10-22-agent-to-agent.md).
--
-- A spawn is a child thread, not a special run: the tree edge is
-- parent_thread_id and depth is its real depth. A closed node keeps its rows
-- and attachments; closed_at only stops deliveries.

ALTER TABLE agent_threads
    ADD COLUMN IF NOT EXISTS parent_thread_id UUID REFERENCES agent_threads(id);
ALTER TABLE agent_threads ADD COLUMN IF NOT EXISTS depth INT NOT NULL DEFAULT 0;
ALTER TABLE agent_threads ADD COLUMN IF NOT EXISTS closed_at TIMESTAMPTZ;

ALTER TABLE agent_threads DROP CONSTRAINT IF EXISTS agent_threads_kind_check;
ALTER TABLE agent_threads ADD CONSTRAINT agent_threads_kind_check
    CHECK (kind IN ('default', 'thread', 'routine_run', 'delegated'));

CREATE INDEX IF NOT EXISTS agent_threads_parent_idx ON agent_threads (parent_thread_id);

-- A child run ends by writing one delivery row in the parent thread. The
-- consuming run stamps consumed_by_run_id, so the batch is durable state and
-- not a timer.
ALTER TABLE thread_events
    ADD COLUMN IF NOT EXISTS consumed_by_run_id UUID REFERENCES agent_runs(id);

CREATE INDEX IF NOT EXISTS thread_events_child_result_idx
    ON thread_events (chat_id) WHERE type = 'child_result';

-- Files travel as attachments on messages. Nullable until the backfill in the
-- migration work package makes them required.
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES thread_events(id);
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS author_kind TEXT;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS author_id UUID;
ALTER TABLE attachments ADD COLUMN IF NOT EXISTS source_path TEXT;

-- A cancelled run is terminal but distinct from a silent one: the parent can
-- tell a stop from a run that chose to say nothing.
ALTER TABLE agent_runs DROP CONSTRAINT IF EXISTS agent_runs_status_check;
ALTER TABLE agent_runs ADD CONSTRAINT agent_runs_status_check
    CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'silent', 'skipped', 'cancelled'));
