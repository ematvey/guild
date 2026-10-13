-- The hourly effect-claim prune looks up each aged claim's owning
-- invocation in turn_commands; chat-keyed dispatch claims use the existing
-- turn_commands_queue index (chat_id WHERE finished_at IS NULL).
CREATE INDEX IF NOT EXISTS turn_commands_invocation ON turn_commands(invocation_id) WHERE invocation_id IS NOT NULL;
