-- Apps (docs/domain/004-capabilities.md, "Apps"): HTML pages an Agent builds
-- that read the Org's Integrations through named data functions. One row
-- per App, one row per published version; the newest version is the one
-- that runs. Any change to either table repaints every member's app list:
-- the change notifies `guild_apps`, which the feed answers with `app_list`.

CREATE TABLE IF NOT EXISTS apps (
    id UUID PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    chat_id UUID REFERENCES chats(id) ON DELETE SET NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    visibility TEXT NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'org')),
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS apps_org_idx ON apps (org_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS app_versions (
    app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    html TEXT NOT NULL,
    functions JSONB NOT NULL DEFAULT '[]'::jsonb,
    sha256 TEXT NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, version)
);

CREATE OR REPLACE FUNCTION guild_notify_apps() RETURNS trigger AS $$
DECLARE
  org UUID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    org := OLD.org_id;
  ELSE
    org := NEW.org_id;
  END IF;
  PERFORM pg_notify('guild_apps', json_build_object('org_id', org)::text);
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS apps_notify ON apps;
CREATE TRIGGER apps_notify AFTER INSERT OR UPDATE OR DELETE ON apps
  FOR EACH ROW EXECUTE FUNCTION guild_notify_apps();
