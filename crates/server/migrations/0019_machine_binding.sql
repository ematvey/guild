-- Bind chats to a machine (executor): machine tools run only there.
ALTER TABLE chats ADD COLUMN machine_id TEXT;
ALTER TABLE chats ADD COLUMN machine_label TEXT;
