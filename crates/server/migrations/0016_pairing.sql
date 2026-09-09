-- One-time pairing tokens for desktop-app enrollment. The webapp shows the
-- plaintext code once, the desktop app redeems it for a normal session.
CREATE TABLE IF NOT EXISTS pairing_tokens (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    secret_hash TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at TIMESTAMPTZ NOT NULL,
    used_at TIMESTAMPTZ
)
