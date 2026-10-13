-- Auth generation: password resets bump the user's generation, so a session
-- created from a credential validated BEFORE the reset (the redeem → reset →
-- issuance race) never validates even though its row exists.
ALTER TABLE users ADD COLUMN auth_generation BIGINT NOT NULL DEFAULT 0;
ALTER TABLE sessions ADD COLUMN auth_generation BIGINT NOT NULL DEFAULT 0;
