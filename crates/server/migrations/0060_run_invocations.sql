-- Effect-claim pruning needs a durable terminal boundary: the owning
-- invocation's id is recorded on the run it opened, and the maintenance
-- loop prunes a claim only when that invocation finished (succeeded or
-- failed). Claims with no known owning invocation are kept permanently
-- (tombstone) — repeated-action safety beats storage.
ALTER TABLE routine_runs ADD COLUMN IF NOT EXISTS invocation_id TEXT;
