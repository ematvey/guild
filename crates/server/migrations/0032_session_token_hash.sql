-- Sessions store only the sha256 hash of the bearer token (api keys and
-- pairing codes already do); a database dump no longer converts into
-- session theft. Existing plaintext rows stop validating on deploy —
-- every client re-logs in once.
ALTER TABLE sessions RENAME COLUMN token TO token_hash;
