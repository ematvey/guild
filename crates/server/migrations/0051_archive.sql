-- Archive: a soft-hide. Archived chats and projects stay in the DB (direct
-- links still resolve) but are excluded from every list the sidebar and the
-- project picker read.
ALTER TABLE chats ADD COLUMN archived_at TIMESTAMPTZ;
ALTER TABLE projects ADD COLUMN archived_at TIMESTAMPTZ;
