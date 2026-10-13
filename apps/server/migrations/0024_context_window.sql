-- Context-usage gauge (feat/gauge): per-route context window in tokens.
-- NULL = unknown; the thread readout then falls back to the default 128000.
ALTER TABLE model_routes ADD COLUMN IF NOT EXISTS context_window BIGINT;
