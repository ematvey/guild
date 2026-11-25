CREATE INDEX coordination_launched_run ON agent_coordination_inputs(launched_run_id)
  WHERE launched_run_id IS NOT NULL;

CREATE FUNCTION guild_publish_coordination(agent uuid, owner_id uuid) RETURNS void AS $$
  SELECT pg_notify('guild_agent_coordination',
    json_build_object('org_id', org_id, 'agent_id', id, 'user_id', owner_id)::text)
  FROM agents WHERE id=agent;
$$ LANGUAGE sql;

CREATE FUNCTION guild_notify_coordination() RETURNS trigger AS $$
BEGIN
  IF TG_TABLE_NAME = 'agent_coordination_state' THEN
    PERFORM guild_publish_coordination(NEW.agent_id, NULL);
  ELSIF TG_TABLE_NAME = 'agent_runs' THEN
    PERFORM guild_publish_coordination(i.agent_id, i.user_id)
    FROM agent_coordination_inputs i
    WHERE i.launched_run_id=NEW.id;
  ELSIF NEW.kind IN ('request','candidate','work_followup') THEN
    PERFORM guild_publish_coordination(NEW.agent_id, NEW.user_id);
  END IF;
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER agent_coordination_inputs_notify
  AFTER INSERT OR UPDATE OF delivered_at, reply_due_at, reply_missing, reply_delivered_at, reply_failed_at,
    decision, decision_reason, matched_rule, accepted_scope, launched_run_id, launch_error
  ON agent_coordination_inputs FOR EACH ROW EXECUTE FUNCTION guild_notify_coordination();

CREATE TRIGGER agent_coordination_pause_notify
  AFTER INSERT OR UPDATE OF paused_at ON agent_coordination_state
  FOR EACH ROW EXECUTE FUNCTION guild_notify_coordination();

CREATE TRIGGER agent_coordination_reports_notify
  AFTER UPDATE OF status, finished_at, work_report_state, work_report_summary, work_report_question
  ON agent_runs FOR EACH ROW EXECUTE FUNCTION guild_notify_coordination();
