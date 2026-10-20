-- Codemode is part of every agent's runtime, not a selectable tool.
UPDATE agents
SET tools = tools - 'codemode'
WHERE tools ? 'codemode';
