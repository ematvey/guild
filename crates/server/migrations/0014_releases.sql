-- Client release artifacts (M7 follow-up): downloadable client builds.
-- kind: cli or desktop. platform examples: linux-x86_64, darwin-aarch64.
CREATE TABLE IF NOT EXISTS releases (
    id UUID PRIMARY KEY,
    version TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('cli','desktop')),
    platform TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes BIGINT NOT NULL,
    sha256 TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    object_key TEXT NOT NULL UNIQUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (version, kind, platform)
);
