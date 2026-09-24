-- Effect-claim pruning (server_kv): a write timestamp lets the hourly loop
-- retire durable effect claims and results after their invocation can no
-- longer replay (Restate journal retention is far shorter than this bound).
ALTER TABLE server_kv ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
