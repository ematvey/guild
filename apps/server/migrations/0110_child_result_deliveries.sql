-- Child results waiting for their parent's conversation. A settled child run
-- queues one row here; a parent run takes the row (consumed_by_run_id) and
-- submits it as an input whose entry the transcript card is projected from.
-- The card is not written to thread_events before the parent has it.
CREATE TABLE IF NOT EXISTS child_result_deliveries (
    id UUID PRIMARY KEY,
    parent_chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    -- The child run; a run delivers one result.
    run_id UUID NOT NULL UNIQUE,
    -- The child_result thread event the card shows.
    event JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_by_run_id UUID
);

CREATE INDEX IF NOT EXISTS child_result_deliveries_pending_idx
    ON child_result_deliveries (parent_chat_id, created_at) WHERE consumed_by_run_id IS NULL;
