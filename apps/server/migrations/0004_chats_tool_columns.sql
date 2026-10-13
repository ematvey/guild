-- Tool-calling columns (milestone 2). Kept as a separate migration so
-- databases that already applied 0003 upgrade in place.
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_calls JSONB;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS tool_call_id TEXT;
