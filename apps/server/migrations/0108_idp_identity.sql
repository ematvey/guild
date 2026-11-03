-- The user's identity-provider link: the refresh token the OIDC login flow
-- stores, the endpoint that replays it, and when it was last replayed.
-- Activity revalidation replays it to ask the IdP whether the account still
-- exists (platform/idp-recheck.ts). One link per user; a re-login rewrites
-- it.
CREATE TABLE IF NOT EXISTS oidc_identities (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    token_endpoint TEXT NOT NULL,
    encrypted_refresh_token TEXT NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
