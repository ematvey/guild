-- Masked preview of an integration secret (e.g. "••••a1b2"), computed from
-- the plaintext at write time. The encrypted value stays the only readable
-- form; the preview lets admins recognize a stored credential without
-- exposing it.
ALTER TABLE integration_secrets ADD COLUMN masked text NOT NULL DEFAULT '';
