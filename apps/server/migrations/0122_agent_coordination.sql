ALTER TABLE chats ADD COLUMN internal boolean NOT NULL DEFAULT false;
ALTER TABLE agent_threads ADD COLUMN execution_role text NOT NULL DEFAULT 'thread'
  CHECK (execution_role IN ('thread', 'coordinator', 'inbox', 'reflection'));
ALTER TABLE agent_threads ADD COLUMN coordinator_managed boolean NOT NULL DEFAULT false;
ALTER TABLE agent_threads ADD COLUMN surfaced boolean NOT NULL DEFAULT false;
ALTER TABLE agent_threads ADD COLUMN source_input_id uuid;
CREATE UNIQUE INDEX agent_coordinator_unique ON agent_threads(agent_id) WHERE execution_role = 'coordinator';
CREATE UNIQUE INDEX agent_inbox_unique ON agent_threads(agent_id, user_id) WHERE execution_role = 'inbox';

CREATE TABLE agent_coordination_inputs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seq bigserial UNIQUE NOT NULL,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users(id),
  source_thread_id uuid REFERENCES agent_threads(id) ON DELETE SET NULL,
  source_event_id uuid UNIQUE,
  kind text NOT NULL DEFAULT 'observation',
  content text NOT NULL DEFAULT '',
  wake boolean NOT NULL DEFAULT false,
  due_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  delivered_at timestamptz,
  reflected_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX agent_coordination_pending ON agent_coordination_inputs(due_at, seq) WHERE delivered_at IS NULL;
CREATE TABLE agent_memory_reads (
  thread_id uuid NOT NULL REFERENCES agent_threads(id) ON DELETE CASCADE,
  path text NOT NULL,
  hash text NOT NULL,
  PRIMARY KEY(thread_id,path)
);
ALTER TABLE agent_threads ADD CONSTRAINT source_input_fk FOREIGN KEY (source_input_id)
  REFERENCES agent_coordination_inputs(id) ON DELETE SET NULL;

CREATE TABLE agent_coordination_state (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  reflection_thread_id uuid REFERENCES agent_threads(id) ON DELETE SET NULL,
  reflection_started_at timestamptz,
  reflection_inputs uuid[] NOT NULL DEFAULT '{}',
  reflection_operations text[] NOT NULL DEFAULT '{}',
  compacted_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION capture_coordination_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE node record; text_content text;
BEGIN
  IF NEW.type NOT IN ('user_message', 'assistant_message') THEN RETURN NEW; END IF;
  SELECT t.*, a.is_personal, a.resources INTO node
    FROM agent_threads t JOIN agents a ON a.id = t.agent_id WHERE t.chat_id = NEW.chat_id;
  IF NOT FOUND OR node.execution_role IN ('coordinator', 'reflection')
     OR NOT COALESCE(CASE WHEN jsonb_typeof(node.resources #> '{assistant,enabled}') = 'boolean' THEN (node.resources #>> '{assistant,enabled}')::boolean END, node.is_personal)
     OR (node.execution_role = 'inbox' AND NEW.type <> 'user_message') THEN RETURN NEW; END IF;
  IF NEW.type = 'assistant_message' THEN
    IF EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(NEW.payload->'blocks', '[]')) b
               WHERE b->>'type' = 'tool_call') THEN RETURN NEW; END IF;
    -- Delegated results have their own idempotent waking delivery.
    IF node.parent_thread_id IS NOT NULL AND node.coordinator_managed THEN RETURN NEW; END IF;
    SELECT string_agg(b->>'text', E'\n') INTO text_content
      FROM jsonb_array_elements(COALESCE(NEW.payload->'blocks', '[]')) b WHERE b->>'type' = 'text';
  ELSE
    text_content := NEW.payload->>'content';
  END IF;
  INSERT INTO agent_coordination_inputs(agent_id, user_id, source_thread_id, source_event_id, kind, content, wake)
    VALUES(node.agent_id, node.user_id, node.id, NEW.id,
      CASE WHEN node.execution_role = 'inbox' THEN 'request' WHEN node.type = 'routine' THEN 'routine' ELSE 'observation' END,
      COALESCE(text_content, ''),
      (node.execution_role = 'inbox' AND NEW.type = 'user_message') OR (node.type = 'routine' AND NEW.type = 'assistant_message'))
    ON CONFLICT (source_event_id) DO NOTHING;
  RETURN NEW;
END $$;
CREATE TRIGGER thread_coordination_input AFTER INSERT ON thread_events
  FOR EACH ROW EXECUTE FUNCTION capture_coordination_input();

CREATE FUNCTION notify_coordination_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent_agent uuid; org uuid;
BEGIN
  SELECT p.agent_id,a.org_id INTO parent_agent,org FROM agent_threads p JOIN agents a ON a.id=p.agent_id
    WHERE p.id=NEW.parent_thread_id AND p.execution_role='coordinator';
  IF parent_agent IS NOT NULL THEN
    PERFORM pg_notify('guild_agent_threads',json_build_object('org_id',org,'user_id',NEW.user_id,'agent_id',parent_agent)::text);
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER coordination_task_notify AFTER INSERT OR UPDATE ON agent_threads
  FOR EACH ROW EXECUTE FUNCTION notify_coordination_task();
