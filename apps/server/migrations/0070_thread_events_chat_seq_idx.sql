-- The sidebar lists order chats by recent activity (the latest thread
-- event's time, falling back to the chat's creation): each listed chat
-- probes its newest event row (ORDER BY seq DESC LIMIT 1), so the probe
-- must be an index scan, not a scan of the chat's whole event log.
CREATE INDEX IF NOT EXISTS thread_events_chat_seq_idx ON thread_events (chat_id, seq DESC);