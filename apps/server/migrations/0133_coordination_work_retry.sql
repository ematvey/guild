ALTER TABLE agent_coordination_inputs
  ADD COLUMN launch_attempt integer NOT NULL DEFAULT 1,
  ADD CONSTRAINT coordination_launch_attempt CHECK (launch_attempt > 0);
