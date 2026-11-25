ALTER TABLE agent_runs ADD COLUMN internal boolean NOT NULL DEFAULT false;

UPDATE agent_runs r
SET internal = true
FROM agent_threads t JOIN chats c ON c.id = t.chat_id
WHERE r.thread_id = t.id AND c.internal;

CREATE FUNCTION retain_internal_run_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE chat_internal boolean;
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.internal THEN
    NEW.internal := true;
  ELSE
    SELECT c.internal INTO chat_internal
    FROM agent_threads t JOIN chats c ON c.id = t.chat_id
    WHERE t.id = NEW.thread_id FOR SHARE OF c;
    NEW.internal := COALESCE(chat_internal, false);
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER agent_run_internal_provenance
BEFORE INSERT OR UPDATE OF thread_id ON agent_runs
FOR EACH ROW EXECUTE FUNCTION retain_internal_run_provenance();

CREATE FUNCTION mark_runs_on_internal_chat() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agent_runs r SET internal = true
  FROM agent_threads t WHERE t.chat_id = NEW.id AND r.thread_id = t.id AND NOT r.internal;
  RETURN NULL;
END $$;

CREATE TRIGGER mark_runs_on_internal_chat
AFTER UPDATE OF internal ON chats
FOR EACH ROW WHEN (NEW.internal AND NOT OLD.internal)
EXECUTE FUNCTION mark_runs_on_internal_chat();
