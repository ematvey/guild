-- Durable initial delivery for each interval schedule generation.
CREATE TABLE routine_schedule_starts (
    generation UUID PRIMARY KEY,
    routine_id UUID NOT NULL REFERENCES routines(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'dispatched', 'started', 'retired')),
    invocation_id TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX routine_schedule_starts_pending ON routine_schedule_starts(created_at) WHERE status = 'pending';

-- Rotate enabled schedules once so legacy and pre-outbox timer chains retire
-- on their next config check. Creation of the replacement starter is atomic.
WITH rotated AS (
    UPDATE routines SET trigger_config = jsonb_set(trigger_config, '{schedule_generation}', to_jsonb(gen_random_uuid()::text))
    WHERE enabled AND trigger_kind = 'interval'
    RETURNING id, trigger_config
)
INSERT INTO routine_schedule_starts (generation, routine_id)
SELECT (trigger_config->>'schedule_generation')::uuid, id FROM rotated;
