ALTER TABLE agent_coordination_inputs ADD COLUMN handback_reason text;

CREATE OR REPLACE FUNCTION capture_coordination_input() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE node record; text_content text; work_agent uuid;
BEGIN
  IF NEW.type NOT IN ('user_message', 'assistant_message') THEN RETURN NEW; END IF;
  SELECT t.*, a.is_personal, a.resources INTO node
    FROM agent_threads t JOIN agents a ON a.id = t.agent_id WHERE t.chat_id = NEW.chat_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  IF NEW.type = 'user_message' AND node.coordinator_managed AND node.source_input_id IS NOT NULL
     AND EXISTS (SELECT 1 FROM turn_commands c WHERE c.id=NEW.id AND c.chat_id=NEW.chat_id AND c.user_id=node.user_id) THEN
    SELECT i.agent_id INTO work_agent
      FROM agent_coordination_inputs i JOIN agent_runs r ON r.id=i.accepted_parent_run_id
      WHERE i.id=node.source_input_id AND i.accepted_scope IS NOT NULL
        AND r.thread_id=node.parent_thread_id AND i.user_id=node.user_id AND i.accepted_agent_id=node.agent_id;
    IF work_agent IS NOT NULL THEN
      INSERT INTO agent_coordination_inputs(agent_id,user_id,source_thread_id,source_event_id,kind,content,delivered_at)
      VALUES(work_agent,node.user_id,node.id,NEW.id,'work_followup',COALESCE(NEW.payload->>'content',''),now())
      ON CONFLICT (source_event_id) DO NOTHING;
      RETURN NEW;
    END IF;
  END IF;
  IF node.execution_role IN ('coordinator', 'reflection')
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
