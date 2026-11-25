ALTER TABLE agent_coordination_inputs ADD COLUMN attached_thread_id uuid;
ALTER TABLE agent_coordination_inputs DROP CONSTRAINT coordination_work_state;
ALTER TABLE agent_coordination_inputs ADD CONSTRAINT coordination_work_state CHECK (
  (accepted_scope IS NULL AND accepted_agent_id IS NULL AND accepted_name IS NULL AND attached_thread_id IS NULL
    AND accepted_parent_run_id IS NULL AND launch_due_at IS NULL
    AND launched_run_id IS NULL AND launch_error IS NULL)
  OR (accepted_agent_id IS NOT NULL AND accepted_parent_run_id IS NOT NULL AND launch_due_at IS NOT NULL
    AND (launched_run_id IS NULL OR launch_error IS NULL)
    AND ((kind='request' AND reply_due_at IS NOT NULL AND NOT reply_missing
      AND ((accepted_scope IS NOT NULL AND attached_thread_id IS NULL)
        OR (accepted_scope IS NULL AND attached_thread_id IS NOT NULL AND accepted_name IS NULL)))
      OR (kind='candidate' AND decision IS NOT NULL AND decision='accepted'
        AND accepted_scope IS NOT NULL AND attached_thread_id IS NULL)))
);
