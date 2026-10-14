-- API keys gain an owner: keys minted by a user in their own settings are
-- attributed to that user (usage, quota); legacy admin-minted org keys keep
-- user_id NULL.
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX IF NOT EXISTS api_keys_user_id_idx ON api_keys(user_id);
