-- Per-route sampling temperature. NULL = provider default (the model's
-- generation_config, which for glm-5.3-flash is temperature 1.0 — the
-- source of stray-token corruption in long tool-call scripts). When set,
-- a client that does not send its own temperature gets this value.
ALTER TABLE model_routes ADD COLUMN IF NOT EXISTS temperature REAL;
