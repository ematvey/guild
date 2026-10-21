-- Tool allowlist modes (docs/specs/2026-10-21-unified-threads.md).
--
-- `all` follows the org's enabled tools at turn time, so a tool enabled later
-- reaches the agent without an edit. `selected` uses the stored list.
-- The personal agent follows everything by default.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS tools_mode TEXT NOT NULL DEFAULT 'selected';
ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_tools_mode_check;
ALTER TABLE agents ADD CONSTRAINT agents_tools_mode_check CHECK (tools_mode IN ('selected', 'all'));

UPDATE agents SET tools_mode = 'all' WHERE is_personal;
