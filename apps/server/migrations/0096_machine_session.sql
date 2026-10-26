-- The session a machine registered with (migration 0046). Deauthorizing a
-- machine revokes this session, so the app on that machine cannot sign back
-- in with the token it already holds and re-register itself.

ALTER TABLE machines ADD COLUMN IF NOT EXISTS session_hash TEXT;
