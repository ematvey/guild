-- Durable machine registry: one row per desktop pairing. Liveness lives in
-- the connection hub; this table is the durable record that the machines
-- page and bind checks read, so offline machines stay known and bindable.
CREATE TABLE IF NOT EXISTS machines (
    machine_id TEXT PRIMARY KEY,
    org_id UUID NOT NULL REFERENCES orgs(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    label TEXT,
    hardware_fingerprint TEXT,
    os TEXT,
    os_version TEXT,
    app_version TEXT,
    last_ip TEXT,
    first_connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_connected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    re_paired_at TIMESTAMPTZ
);

-- Fingerprint adoption lookup: same org, one physical machine.
CREATE INDEX IF NOT EXISTS machines_org_fingerprint_idx
    ON machines (org_id, hardware_fingerprint)
    WHERE hardware_fingerprint IS NOT NULL;

CREATE INDEX IF NOT EXISTS machines_user_idx ON machines (user_id);
