-- Routine webhook tokens are bearer credentials: store only their sha256
-- hash (api keys and pairing codes already do). Existing plaintext values
-- convert in place; clients holding the plaintext token keep working — the
-- presented token is hashed and compared.
CREATE EXTENSION IF NOT EXISTS pgcrypto;
ALTER TABLE routines ADD COLUMN IF NOT EXISTS webhook_token_hash TEXT;
UPDATE routines SET webhook_token_hash = encode(digest(webhook_token, 'sha256'), 'hex');
ALTER TABLE routines ALTER COLUMN webhook_token_hash SET NOT NULL;
ALTER TABLE routines DROP COLUMN webhook_token;
