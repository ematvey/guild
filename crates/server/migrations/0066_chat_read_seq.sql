-- Read markers move from an event id to the event's global write order
-- (`seq`). Event ids are not comparable: durable workflow events carry
-- deterministic uuid v5 ids (idempotent replay), so the id-based
-- `e.id > marker` comparison misordered events and resurrected unread dots
-- on refresh. `seq` is a monotonic BIGSERIAL — the same order space
-- mark_read already selects the marker from.
ALTER TABLE chat_reads ADD COLUMN last_read_seq BIGINT;

-- A marker whose event is gone reads as never-read: drop it (the marker is
-- cosmetic; a fresh open rewrites it).
DELETE FROM chat_reads r
 WHERE NOT EXISTS (SELECT 1 FROM thread_events e WHERE e.id = r.last_read_event_id);

UPDATE chat_reads r
   SET last_read_seq = (SELECT e.seq FROM thread_events e WHERE e.id = r.last_read_event_id);

ALTER TABLE chat_reads ALTER COLUMN last_read_seq SET NOT NULL;
ALTER TABLE chat_reads DROP COLUMN last_read_event_id;

-- The unread EXISTS walks a chat's events by seq now.
CREATE INDEX thread_events_chat_seq_idx ON thread_events (chat_id, seq);
