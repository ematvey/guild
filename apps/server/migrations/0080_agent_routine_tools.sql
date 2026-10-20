-- Routines are managed through the agent: existing agents gain the routine
-- tools without losing any tool they already had. New agents get them from
-- DEFAULT_AGENT_TOOLS.
UPDATE agents
SET tools = tools || COALESCE(
    (
      SELECT jsonb_agg(tool)
      FROM unnest(ARRAY['list_routines', 'create_routine', 'update_routine', 'delete_routine']) AS tool
      WHERE NOT tools ? tool
    ),
    '[]'::jsonb
  )
WHERE status <> 'deleted';
