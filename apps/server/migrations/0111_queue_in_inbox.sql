-- The conversation's inbox (pi-durable's submissions and pi.inbox document)
-- is the only queue of pending inputs. A thread row exists only once its
-- input is placed, projected from the conversation entry.

-- Child results are inputs keyed by the child run id; they no longer wait
-- in a table of their own.
DROP TABLE IF EXISTS child_result_deliveries;

-- Queued member messages are no longer thread rows marked `queued`. A row
-- still marked is history: it renders as the message it is.
UPDATE thread_events
SET payload = payload - 'queued' - 'mode'
WHERE type = 'user_message' AND (payload ? 'queued' OR payload ? 'mode');
