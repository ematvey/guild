-- The chat ↔ durable-conversation mapping, with the project instruction
-- chain of the chat's latest desktop submit (a resumed run configures the
-- same instructions its submit did). Databases that already hold the table
-- keep it: both statements are idempotent.
--
-- 0092 (the child-request backfill) ran before this table existed on a
-- fresh database and did nothing there; a fresh database has no child chats
-- from before the spawn wrote its request, so nothing is left to backfill.
CREATE TABLE IF NOT EXISTS chat_conversations (
  chat_id UUID PRIMARY KEY REFERENCES chats(id) ON DELETE CASCADE,
  conversation_id BIGINT NOT NULL UNIQUE
);

ALTER TABLE chat_conversations ADD COLUMN IF NOT EXISTS project_instructions TEXT;
