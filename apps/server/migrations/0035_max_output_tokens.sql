-- Per-route max output tokens (Anthropic requires an explicit max_tokens;
-- a single hard-coded cap starved long answers). NULL = provider default.
ALTER TABLE model_routes ADD COLUMN IF NOT EXISTS max_output_tokens BIGINT;
