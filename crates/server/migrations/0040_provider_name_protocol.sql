-- Providers become named objects: a display name and the wire protocol are
-- separate from the slug that routes reference ("openai" names a protocol,
-- not a provider).
ALTER TABLE provider_keys ADD COLUMN name TEXT;
ALTER TABLE provider_keys ADD COLUMN protocol TEXT;

-- Backfill: the old slug doubles as both the display name and the protocol.
UPDATE provider_keys SET name = provider, protocol = provider;

ALTER TABLE provider_keys ALTER COLUMN name SET NOT NULL;
ALTER TABLE provider_keys ALTER COLUMN protocol SET NOT NULL;
