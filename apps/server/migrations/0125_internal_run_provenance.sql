ALTER TABLE agent_runs ADD COLUMN internal boolean NOT NULL DEFAULT false;

UPDATE agent_runs r
SET internal = true
FROM agent_threads t JOIN chats c ON c.id = t.chat_id
WHERE r.thread_id = t.id AND c.internal;

CREATE FUNCTION retain_internal_run_provenance() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.internal THEN
    NEW.internal := true;
  ELSE
    NEW.internal := EXISTS (
      SELECT 1 FROM agent_threads t JOIN chats c ON c.id = t.chat_id
      WHERE t.id = NEW.thread_id AND c.internal
    );
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER agent_run_internal_provenance
BEFORE INSERT OR UPDATE OF thread_id ON agent_runs
FOR EACH ROW EXECUTE FUNCTION retain_internal_run_provenance();
