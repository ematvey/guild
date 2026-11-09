-- App grants (docs/domain/004-capabilities.md, "Apps"): a viewer's standing
-- yes to one data function of one App version. A function whose tool asks
-- before every call runs without asking while its grant exists. The grant
-- names the version, so a new version asks again; the viewer clears their
-- grants from the App's menu.

CREATE TABLE IF NOT EXISTS app_grants (
    app_id UUID NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    function TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (app_id, user_id, version, function)
);
