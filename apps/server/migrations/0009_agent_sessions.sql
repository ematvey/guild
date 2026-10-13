-- Server-side agent sessions (M6 task 3): one row per workspace execution
-- backend session. History lives in chats/messages.
CREATE TABLE IF NOT EXISTS agent_sessions (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    workspace_name TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (org_id, workspace_name)
);
