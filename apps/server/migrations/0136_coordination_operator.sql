ALTER TABLE agent_coordination_state ADD COLUMN paused_at timestamptz;
ALTER TABLE agent_coordination_inputs ADD COLUMN evaluation_request_id uuid;
CREATE UNIQUE INDEX coordination_evaluation_request ON agent_coordination_inputs(evaluation_request_id)
  WHERE evaluation_request_id IS NOT NULL;
