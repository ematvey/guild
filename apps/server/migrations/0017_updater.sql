-- Tauri updater (minisign) signature content for the artifact
-- (empty for artifacts not used by the desktop auto-updater)
ALTER TABLE releases ADD COLUMN updater_signature TEXT NOT NULL DEFAULT ''
