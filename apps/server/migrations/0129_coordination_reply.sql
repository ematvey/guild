ALTER TABLE agent_coordination_inputs
  ADD COLUMN reply_text text,
  ADD COLUMN reply_delivered_at timestamptz,
  ADD COLUMN reply_failed_at timestamptz,
  ADD COLUMN reply_due_at timestamptz,
  ADD CONSTRAINT coordination_reply_state CHECK (
    (reply_text IS NULL AND reply_due_at IS NULL AND reply_delivered_at IS NULL AND reply_failed_at IS NULL)
    OR (kind = 'request' AND reply_due_at IS NOT NULL AND (
      (reply_text IS NOT NULL AND reply_delivered_at IS NULL AND reply_failed_at IS NULL)
      OR (reply_text IS NULL AND num_nonnulls(reply_delivered_at, reply_failed_at) = 1)))
  );

CREATE INDEX coordination_replies_pending ON agent_coordination_inputs(reply_due_at, seq)
  WHERE reply_due_at IS NOT NULL AND reply_delivered_at IS NULL AND reply_failed_at IS NULL;
