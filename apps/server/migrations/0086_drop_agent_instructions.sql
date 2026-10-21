-- An agent's instructions live in AGENTS.md in its workspace, seeded from the
-- template and edited by the agent itself. The column has no reader left.
ALTER TABLE agents DROP COLUMN IF EXISTS instructions;
