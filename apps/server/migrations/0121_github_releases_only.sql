DELETE FROM releases WHERE download_url IS NULL;
ALTER TABLE releases
    ALTER COLUMN download_url SET NOT NULL,
    DROP COLUMN object_key,
    DROP COLUMN content_type,
    DROP COLUMN signature,
    ADD CONSTRAINT releases_desktop_only CHECK (kind = 'desktop');
DELETE FROM server_kv WHERE key IN ('release_signing_seed', 'desktop_release_version');
DELETE FROM server_kv
WHERE key IN ('desktop_release_version:stable', 'desktop_release_version:develop')
  AND NOT EXISTS (SELECT 1 FROM releases WHERE version = server_kv.value);
