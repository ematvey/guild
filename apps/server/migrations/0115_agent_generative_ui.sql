-- Generated UI per agent (docs/domain/004-capabilities.md, "Generated UI").
--
-- On: the agent's instructions teach the Generated UI component library and
-- its replies may carry `openui` blocks the client renders as components.
-- On by default; the owner turns it off in the agent's settings.

ALTER TABLE agents ADD COLUMN IF NOT EXISTS generative_ui BOOLEAN NOT NULL DEFAULT TRUE;
