ALTER TABLE agent_coordination_inputs
  ADD COLUMN reply_missing boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT coordination_missing_reply_state
    CHECK (NOT reply_missing OR (kind = 'request' AND reply_due_at IS NOT NULL));
