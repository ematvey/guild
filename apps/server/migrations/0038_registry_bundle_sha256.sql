ALTER TABLE registry_versions ADD COLUMN bundle_sha256 TEXT;
ALTER TABLE registry_items ADD COLUMN reviewed_bundle_sha256 TEXT;
