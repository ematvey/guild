-- The chat's workspace folder ("run in folder") is server-visible state:
-- the web and other machines render it next to the machine indicator, so
-- the bound desktop pushes its folder choice here (rework 2026-09-16).
ALTER TABLE chats ADD COLUMN IF NOT EXISTS project_dir TEXT;
