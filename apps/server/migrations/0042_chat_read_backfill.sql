-- First-run backfill for thread-list status (0041): every thread that
-- existed before the feature counts as read up to its newest event — the
-- dot exists for turns that finish after the deploy, not for all history.
INSERT INTO chat_reads (chat_id, user_id, last_read_event_id)
SELECT l.chat_id, c.user_id, l.id
FROM (
    SELECT DISTINCT ON (chat_id) chat_id, id
    FROM thread_events
    ORDER BY chat_id, seq DESC
) l
JOIN chats c ON c.id = l.chat_id
ON CONFLICT (chat_id, user_id) DO NOTHING;
