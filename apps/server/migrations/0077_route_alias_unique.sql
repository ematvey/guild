-- A display name identifies a route to chat users, so two routes of one org
-- cannot share one. Case-insensitive: the picker would show the same label.
-- An unnamed route keeps the empty default and may repeat it.
CREATE UNIQUE INDEX IF NOT EXISTS model_routes_org_alias_idx
    ON model_routes (org_id, lower(alias))
    WHERE alias <> '';
