CREATE TABLE turn_commands (
  id UUID PRIMARY KEY,
  org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  position BIGSERIAL UNIQUE,
  request JSONB NOT NULL,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'submitted', 'running', 'completed', 'failed', 'cancelled')),
  invocation_id TEXT,
  started_seq BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at TIMESTAMPTZ
);
CREATE INDEX turn_commands_queue ON turn_commands(chat_id, position) WHERE finished_at IS NULL;
