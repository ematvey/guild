-- Agent descriptions (docs/specs/2026-10-22-agent-to-agent.md, decision 30).
--
-- The description tells another agent what this agent is for. The owner sets
-- it; the agent may rewrite its own with set_description. Empty is valid.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS description TEXT NOT NULL DEFAULT '';
