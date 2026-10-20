-- Delegation artifact declarations: the files a child run returned to its
-- parent. Small files land in the parent's inbox/<run-id>/; files above the
-- size threshold stay in the shared staging area until release_artifacts.
CREATE TABLE IF NOT EXISTS agent_delegation_artifacts (
    id UUID PRIMARY KEY,
    run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    parent_run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    path TEXT NOT NULL,
    size BIGINT NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'inbox'
        CHECK (status IN ('inbox', 'staged', 'released')),
    inbox_path TEXT,
    staging_path TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (run_id, path)
);

CREATE INDEX IF NOT EXISTS agent_delegation_artifacts_run_idx
    ON agent_delegation_artifacts (run_id, created_at);
CREATE INDEX IF NOT EXISTS agent_delegation_artifacts_parent_idx
    ON agent_delegation_artifacts (parent_run_id, created_at);
