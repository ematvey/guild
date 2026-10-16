CREATE TABLE chat_task_projections (
  task_id BIGINT PRIMARY KEY,
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  event_id UUID NOT NULL UNIQUE REFERENCES thread_events(id) ON DELETE CASCADE
);
CREATE INDEX chat_task_projections_chat ON chat_task_projections(chat_id, task_id);
CREATE TABLE chat_submission_projections (
  submission_id BIGINT PRIMARY KEY,
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  entry_id BIGINT,
  answer_id BIGINT
);
CREATE INDEX chat_submission_projections_chat ON chat_submission_projections(chat_id, submission_id);
CREATE TABLE chat_recovery_metadata (
  singleton BOOLEAN PRIMARY KEY CHECK (singleton),
  legacy_task_id BIGINT NOT NULL
);
CREATE INDEX chat_submission_projections_active ON chat_submission_projections(chat_id,submission_id)
  WHERE status IN ('queued','placed');
CREATE TABLE chat_reconciliation_cursors (
  chat_id UUID PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  conversation_id BIGINT NOT NULL,
  submission_id BIGINT NOT NULL
);
