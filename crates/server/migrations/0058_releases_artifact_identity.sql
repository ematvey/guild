-- Release identity includes the artifact filename: one (version, platform)
-- can carry several artifacts (macOS DMG + its .app.tar.gz updater bundle),
-- and a republish of one must not delete the other.
ALTER TABLE releases DROP CONSTRAINT releases_version_kind_platform_key;
ALTER TABLE releases ADD CONSTRAINT releases_version_kind_platform_filename_key
    UNIQUE (version, kind, platform, filename);
