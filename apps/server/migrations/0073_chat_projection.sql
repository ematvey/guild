CREATE TABLE chat_entry_projections (
  entry_id BIGINT PRIMARY KEY,
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  event_id UUID NOT NULL UNIQUE REFERENCES thread_events(id) ON DELETE CASCADE
);
CREATE INDEX chat_entry_projections_chat ON chat_entry_projections(chat_id, entry_id);
CREATE TABLE chat_projection_cursors (
  chat_id UUID PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  conversation_id BIGINT NOT NULL,
  entry_id BIGINT NOT NULL,
  turn INTEGER NOT NULL,
  step INTEGER NOT NULL,
  run_open BOOLEAN NOT NULL
);
