-- A claimed routine occurrence records when it was claimed. The claimer
-- links its run moments later; until then another scheduler process must
-- not take the claim back, so only a claim older than the lease with no run
-- returns to pending (its claimer died before launching).

ALTER TABLE agent_routine_occurrences ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;
