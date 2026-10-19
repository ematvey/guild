-- User-visible display name for a model route. The route's model id stays
-- the wire identifier (sent to the provider and used by API clients); the
-- alias is what the chat model picker shows. Empty = fall back to the id
-- (legacy rows until an admin names them).
ALTER TABLE model_routes ADD COLUMN IF NOT EXISTS alias TEXT NOT NULL DEFAULT '';
