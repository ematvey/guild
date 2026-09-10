-- Thread event log (spec docs/plans/2026-09-12-thread-events-design.md §A).
-- The append-only event table becomes the source of truth for chats and
-- the message history is a derivation from here on.
--
-- NOTE: the spec also puts `DROP TABLE IF EXISTS messages` here, but the
-- ChatRunner (worker/restate.rs) still persists via the old messages store
-- until the thread-events worker task lands, and dropping the table now
-- would break every generate turn. The DROP moves to that task together
-- with the removal of the old store functions and /messages handlers.

CREATE TABLE thread_events (
  id UUID PRIMARY KEY,               -- uuid v7, generated at insert
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq BIGSERIAL UNIQUE,              -- global write order
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX thread_events_chat_idx ON thread_events (chat_id, id);
