-- Clean slate (spec §1): every thread-related table is wiped and the chats
-- table is recreated on the project model — project_id replaces project_dir.
-- Tables the server keeps writing to (thread events, read markers,
-- attachments, agent sessions) are recreated empty with their original
-- schema; chats-scoped data is gone, not migrated.
DROP TABLE IF EXISTS thread_events;
DROP TABLE IF EXISTS chat_reads;
DROP TABLE IF EXISTS attachments;
DROP TABLE IF EXISTS agent_sessions;
DROP TABLE IF EXISTS chats;

DELETE FROM server_kv WHERE key LIKE 'tool_dispatch:%' OR key LIKE 'approval:%';

CREATE TABLE chats (
    id            UUID PRIMARY KEY,
    org_id        UUID NOT NULL REFERENCES orgs(id),
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    title         TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    machine_id    TEXT,
    machine_label TEXT,
    generating    BOOLEAN NOT NULL DEFAULT false,
    approval      JSONB,
    project_id    UUID
);

CREATE TABLE thread_events (
    id UUID PRIMARY KEY,               -- uuid v7, generated at insert
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    seq BIGSERIAL UNIQUE,              -- global write order
    type TEXT NOT NULL,
    payload JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX thread_events_chat_idx ON thread_events (chat_id, id);

CREATE TABLE chat_reads (
    chat_id            UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    last_read_event_id UUID NOT NULL,
    PRIMARY KEY (chat_id, user_id)
);

CREATE TABLE attachments (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE agent_sessions (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    workspace_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, workspace_name)
);
