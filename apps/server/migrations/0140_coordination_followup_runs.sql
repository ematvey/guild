ALTER TABLE agent_coordination_inputs
  ADD COLUMN followup_run_id uuid,
  ADD COLUMN attached_request_id uuid;

CREATE INDEX coordination_followup_run ON agent_coordination_inputs(followup_run_id)
  WHERE followup_run_id IS NOT NULL;

UPDATE agent_coordination_state SET reflection_started_at=now() WHERE reflection_started_at IS NULL;

CREATE OR REPLACE FUNCTION guild_notify_coordination() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'agent_coordination_state' THEN
    PERFORM guild_publish_coordination(NEW.agent_id, NULL);
  ELSIF TG_TABLE_NAME = 'agent_runs' THEN
    PERFORM guild_publish_coordination(i.agent_id, i.user_id)
    FROM agent_coordination_inputs i
    WHERE i.launched_run_id=NEW.id OR i.followup_run_id=NEW.id;
  ELSIF NEW.kind IN ('request','candidate','work_followup') THEN
    PERFORM guild_publish_coordination(NEW.agent_id, NEW.user_id);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_coordination_followup_notify AFTER UPDATE OF followup_run_id
  ON agent_coordination_inputs FOR EACH ROW EXECUTE FUNCTION guild_notify_coordination();
