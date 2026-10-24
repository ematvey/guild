-- Thread events are the durable source of truth (spec §A,
-- docs/plans/2026-09-12-thread-events-design.md): every writer now persists
-- through thread_events and history is a derivation. The legacy messages
-- table goes — existing chats keep their (empty) threads, no data
-- preservation, as decided.
DROP TABLE IF EXISTS messages;
