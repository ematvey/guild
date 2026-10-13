-- Tool artifacts (tool artifacts design): spilled oversized tool results.
-- Metadata in Postgres, bytes in object storage under the object key.
CREATE TABLE IF NOT EXISTS tool_artifacts (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    tool_name TEXT NOT NULL,
    call_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
