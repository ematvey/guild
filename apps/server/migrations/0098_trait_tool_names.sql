-- Trait tools carry Guild-provided names: a web search is `web_search`
-- whichever integration implements it. Agent allowlists stored the old
-- slug-namespaced names, so rewrite those entries to the trait names.

UPDATE agents
SET tools = (
  SELECT jsonb_agg(DISTINCT
    CASE
      WHEN right(value, 11) = '_web_search' THEN 'web_search'
      WHEN right(value, 10) = '_web_fetch' THEN 'web_fetch'
      ELSE value
    END
  )
  FROM jsonb_array_elements_text(tools) AS value
)
WHERE EXISTS (
  SELECT 1
  FROM jsonb_array_elements_text(tools) AS t
  WHERE right(t, 11) = '_web_search' OR right(t, 10) = '_web_fetch'
);
