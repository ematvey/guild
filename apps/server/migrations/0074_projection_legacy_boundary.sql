ALTER TABLE chat_projection_cursors ADD COLUMN legacy_through_entry_id BIGINT NOT NULL DEFAULT 0;
DO $$ BEGIN
  IF to_regclass('public.entries') IS NOT NULL THEN
    UPDATE chat_projection_cursors p SET legacy_through_entry_id =
      COALESCE((SELECT max(e.id) FROM entries e WHERE e.conversation_id=p.conversation_id),0);
  END IF;
END $$;
