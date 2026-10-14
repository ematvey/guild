-- One run record per Restate invocation: run-record creation is retried
-- (a lost response after the INSERT committed), and the retry must resolve
-- to the same row instead of leaving a phantom `running` one. Existing
-- duplicates keep their newest row (the one the invocation finished); the
-- older phantoms are closed as failed and released from the invocation.
UPDATE routine_runs SET invocation_id = NULL WHERE invocation_id = '';
UPDATE routine_runs r SET
    status = CASE WHEN r.status = 'running' THEN 'failed' ELSE r.status END,
    error = CASE WHEN r.status = 'running' THEN coalesce(r.error, 'duplicate run record (retried creation)') ELSE r.error END,
    finished_at = coalesce(r.finished_at, now()),
    invocation_id = NULL
WHERE r.invocation_id IS NOT NULL
  AND EXISTS (SELECT 1 FROM routine_runs o WHERE o.invocation_id = r.invocation_id AND o.id > r.id);
CREATE UNIQUE INDEX IF NOT EXISTS routine_runs_invocation ON routine_runs(invocation_id) WHERE invocation_id IS NOT NULL;
