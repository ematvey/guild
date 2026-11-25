ALTER TABLE agent_coordination_inputs
  ADD COLUMN accepted_scope text,
  ADD COLUMN accepted_agent_id uuid,
  ADD COLUMN accepted_name text,
  ADD COLUMN accepted_parent_run_id uuid,
  ADD COLUMN launch_due_at timestamptz,
  ADD COLUMN launched_run_id uuid,
  ADD COLUMN launch_error text,
  ADD CONSTRAINT coordination_work_state CHECK (
    (accepted_scope IS NULL AND accepted_agent_id IS NULL AND accepted_name IS NULL
      AND accepted_parent_run_id IS NULL AND launch_due_at IS NULL
      AND launched_run_id IS NULL AND launch_error IS NULL)
    OR (kind = 'request' AND accepted_scope IS NOT NULL AND accepted_agent_id IS NOT NULL
      AND accepted_parent_run_id IS NOT NULL AND launch_due_at IS NOT NULL AND reply_due_at IS NOT NULL
      AND NOT reply_missing AND (launched_run_id IS NULL OR launch_error IS NULL))
  );

CREATE INDEX coordination_launches_pending ON agent_coordination_inputs(launch_due_at, seq)
  WHERE launch_due_at IS NOT NULL AND launched_run_id IS NULL AND launch_error IS NULL;
