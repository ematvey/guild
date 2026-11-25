ALTER TABLE agent_coordination_inputs
  ADD COLUMN source_name text,
  ADD COLUMN source_key text,
  ADD COLUMN source_policy jsonb,
  ADD COLUMN decision text,
  ADD COLUMN decision_reason text,
  ADD COLUMN matched_rule text,
  ADD CONSTRAINT coordination_source_state CHECK (
    (source_name IS NULL AND source_key IS NULL AND source_policy IS NULL
      AND decision IS NULL AND decision_reason IS NULL AND matched_rule IS NULL)
    OR (kind='candidate' AND source_name IS NOT NULL AND source_key IS NOT NULL AND source_policy IS NOT NULL
      AND (decision IS NULL OR decision IN ('accepted','ignored','would_accept','unavailable'))
      AND ((decision IS NULL) = (decision_reason IS NULL))
      AND ((decision IS NOT NULL AND decision IN ('accepted','would_accept')) = (matched_rule IS NOT NULL)))
  );

CREATE UNIQUE INDEX coordination_external_event ON agent_coordination_inputs(agent_id,source_name,source_key)
  WHERE source_name IS NOT NULL;

ALTER TABLE agent_coordination_inputs DROP CONSTRAINT coordination_work_state;
ALTER TABLE agent_coordination_inputs
  ADD CONSTRAINT coordination_work_state CHECK (
    (accepted_scope IS NULL AND accepted_agent_id IS NULL AND accepted_name IS NULL
      AND accepted_parent_run_id IS NULL AND launch_due_at IS NULL
      AND launched_run_id IS NULL AND launch_error IS NULL)
    OR (accepted_scope IS NOT NULL AND accepted_agent_id IS NOT NULL
      AND accepted_parent_run_id IS NOT NULL AND launch_due_at IS NOT NULL
      AND (launched_run_id IS NULL OR launch_error IS NULL)
      AND ((kind='request' AND reply_due_at IS NOT NULL AND NOT reply_missing)
        OR (kind='candidate' AND decision IS NOT NULL AND decision='accepted')))
  );
