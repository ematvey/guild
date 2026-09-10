-- Model routes gain a reasoning flag: metadata for routes whose model
-- produces chain-of-thought reasoning (reasoning_content). Replay always
-- happens when reasoning exists. The flag marks routes where thinking is
-- expected/allowed.
ALTER TABLE model_routes ADD COLUMN IF NOT EXISTS reasoning BOOLEAN NOT NULL DEFAULT FALSE;
