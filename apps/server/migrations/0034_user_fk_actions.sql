-- Deleting a user must not fail on foreign keys from its owned rows.
-- Per-table choices:
--   sessions.user_id               → CASCADE: a session is meaningless
--                                    without its user.
--   chats.user_id                  → CASCADE: every chat listing filters by
--                                    the owning user, so an orphaned chat
--                                    would be unreachable; its history goes
--                                    with the user.
--   registry_versions.published_by → SET NULL: version rows outlive the
--                                    publisher (audit attribution only).
--   routines.created_by            → SET NULL: routines keep running for the
--                                    org (audit attribution only).
ALTER TABLE sessions DROP CONSTRAINT sessions_user_id_fkey;
ALTER TABLE sessions
  ADD CONSTRAINT sessions_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE chats DROP CONSTRAINT chats_user_id_fkey;
ALTER TABLE chats
  ADD CONSTRAINT chats_user_id_fkey
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;

ALTER TABLE registry_versions DROP CONSTRAINT registry_versions_published_by_fkey;
ALTER TABLE registry_versions
  ADD CONSTRAINT registry_versions_published_by_fkey
  FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE SET NULL;

ALTER TABLE routines DROP CONSTRAINT routines_created_by_fkey;
ALTER TABLE routines
  ADD CONSTRAINT routines_created_by_fkey
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL;
