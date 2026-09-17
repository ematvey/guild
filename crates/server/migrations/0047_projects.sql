-- Projects (spec §1): a named folder bound to a machine; chats attach to a
-- project and the ChatRunner resolves the workspace folder from it.
CREATE TABLE projects (
    id         UUID PRIMARY KEY,
    user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id     UUID NOT NULL REFERENCES orgs(id),
    name       TEXT NOT NULL,
    folder     TEXT NOT NULL,       -- Windows path, UNC for WSL
    machine_id TEXT NOT NULL,       -- machine the folder lives on (no FK, like chats.machine_id)
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (user_id, name)
);
