-- Credentials minted from a session carry the auth generation that session
-- validated at: a password reset that commits around the mint cannot leave a
-- live pairing code (redemption issues a session at the STAMPED generation)
-- or API key (authentication requires the creator's current generation).
ALTER TABLE pairing_tokens ADD COLUMN auth_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE api_keys ADD COLUMN auth_generation BIGINT NOT NULL DEFAULT 0;
UPDATE pairing_tokens p SET auth_generation = u.auth_generation FROM users u WHERE u.id = p.user_id;
UPDATE api_keys k SET auth_generation = u.auth_generation FROM users u WHERE u.id = k.created_by;
