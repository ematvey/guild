-- Persistent agents (docs/specs/2026-10-18-persistent-agents.md). Agents are
-- the single workspace-binding concept; the old workspace session table is
-- retired. Existing session workspaces stay on the volume untouched.
DROP TABLE IF EXISTS agent_sessions;

CREATE TABLE IF NOT EXISTS agents (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    name TEXT NOT NULL,
    instructions TEXT NOT NULL DEFAULT '',
    model TEXT NOT NULL,
    tools JSONB NOT NULL DEFAULT '[]'::jsonb,
    visibility TEXT NOT NULL DEFAULT 'private'
        CHECK (visibility IN ('private', 'team', 'org')),
    resources JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'archived', 'deleting', 'deleted')),
    deleted_at TIMESTAMPTZ,
    purge_after TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agents_org_status_idx ON agents (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS agents_owner_idx ON agents (owner_user_id);

CREATE TABLE IF NOT EXISTS agent_grants (
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'user', 'viewer')),
    PRIMARY KEY (agent_id, user_id)
);

CREATE TABLE IF NOT EXISTS agent_team_grants (
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    team_id UUID NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('editor', 'user', 'viewer')),
    PRIMARY KEY (agent_id, team_id)
);

CREATE TABLE IF NOT EXISTS agent_threads (
    id UUID PRIMARY KEY,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    title TEXT NOT NULL DEFAULT '',
    title_locked BOOLEAN NOT NULL DEFAULT false,
    kind TEXT NOT NULL DEFAULT 'thread'
        CHECK (kind IN ('default', 'thread', 'routine_run')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_activity_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_threads_agent_activity_idx
    ON agent_threads (agent_id, last_activity_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS agent_threads_one_default_idx
    ON agent_threads (agent_id) WHERE kind = 'default';

CREATE TABLE IF NOT EXISTS agent_routines (
    id UUID PRIMARY KEY,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('cron', 'once')),
    schedule TEXT,
    timezone TEXT NOT NULL DEFAULT 'UTC',
    run_at TIMESTAMPTZ,
    prompt TEXT NOT NULL,
    context TEXT NOT NULL DEFAULT 'isolated' CHECK (context = 'isolated'),
    enabled BOOLEAN NOT NULL DEFAULT true,
    next_run_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CHECK (
        (kind = 'cron' AND schedule IS NOT NULL)
        OR (kind = 'once' AND run_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS agent_routines_agent_idx ON agent_routines (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_routines_due_idx ON agent_routines (enabled, next_run_at)
    WHERE enabled AND next_run_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS agent_runs (
    id UUID PRIMARY KEY,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    thread_id UUID REFERENCES agent_threads(id) ON DELETE SET NULL,
    routine_id UUID REFERENCES agent_routines(id) ON DELETE SET NULL,
    parent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
    delegate_agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    depth INTEGER NOT NULL DEFAULT 0,
    trigger TEXT NOT NULL CHECK (trigger IN ('message', 'routine', 'manual', 'delegation')),
    status TEXT NOT NULL DEFAULT 'queued'
        CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'silent', 'skipped')),
    summary TEXT,
    error_code TEXT,
    error_message TEXT,
    error_step TEXT,
    tokens BIGINT NOT NULL DEFAULT 0,
    started_at TIMESTAMPTZ,
    finished_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_runs_agent_activity_idx ON agent_runs (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_activity_idx ON agent_runs (created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_thread_idx ON agent_runs (thread_id, created_at);
CREATE INDEX IF NOT EXISTS agent_runs_routine_idx ON agent_runs (routine_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_parent_idx ON agent_runs (parent_run_id);

CREATE TABLE IF NOT EXISTS agent_routine_occurrences (
    id UUID PRIMARY KEY,
    routine_id UUID NOT NULL REFERENCES agent_routines(id) ON DELETE CASCADE,
    scheduled_for TIMESTAMPTZ NOT NULL,
    run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'claimed', 'done', 'failed', 'skipped')),
    attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT,
    UNIQUE (routine_id, scheduled_for)
);

CREATE INDEX IF NOT EXISTS agent_routine_occurrences_status_idx
    ON agent_routine_occurrences (status, scheduled_for);

CREATE TABLE IF NOT EXISTS agent_thread_chunks (
    id UUID PRIMARY KEY,
    thread_id UUID NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    seq_from INTEGER NOT NULL,
    seq_to INTEGER NOT NULL,
    ts TIMESTAMPTZ NOT NULL DEFAULT now(),
    text TEXT NOT NULL,
    tsv TSVECTOR,
    -- pgvector is not installed; embeddings stay a later additive step.
    embedding DOUBLE PRECISION[],
    CHECK (seq_from <= seq_to)
);

CREATE INDEX IF NOT EXISTS agent_thread_chunks_tsv_idx ON agent_thread_chunks USING GIN (tsv);
CREATE INDEX IF NOT EXISTS agent_thread_chunks_thread_idx ON agent_thread_chunks (thread_id, ts);
CREATE INDEX IF NOT EXISTS agent_thread_chunks_agent_idx ON agent_thread_chunks (agent_id, ts);

CREATE TABLE IF NOT EXISTS agent_workspace_turns (
    id UUID PRIMARY KEY,
    agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    thread_id UUID NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
    run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    finished_at TIMESTAMPTZ,
    paths TEXT[] NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS agent_workspace_turns_agent_idx ON agent_workspace_turns (agent_id, started_at DESC);
CREATE INDEX IF NOT EXISTS agent_workspace_turns_thread_idx ON agent_workspace_turns (thread_id, started_at);
CREATE INDEX IF NOT EXISTS agent_workspace_turns_run_idx ON agent_workspace_turns (run_id);

CREATE TABLE IF NOT EXISTS agent_notices (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS agent_notices_user_idx ON agent_notices (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_notices_unread_idx ON agent_notices (user_id, created_at DESC)
    WHERE read_at IS NULL;
CREATE INDEX IF NOT EXISTS agent_notices_org_idx ON agent_notices (org_id, created_at DESC);
