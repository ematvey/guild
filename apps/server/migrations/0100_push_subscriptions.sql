-- Web Push subscriptions: one row per browser/device that asked for
-- notifications. The endpoint is the push service URL the browser mints; the
-- keys encrypt the payload. A dead endpoint (404/410 from the push service)
-- is deleted, never retried forever.

CREATE TABLE push_subscriptions (
  id uuid PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  -- Client-generated, stable per install: re-subscribing replaces the row.
  device_id text NOT NULL,
  endpoint text NOT NULL UNIQUE,
  p256dh text NOT NULL,
  auth text NOT NULL,
  platform text NOT NULL DEFAULT 'web',
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_error text,
  failed_at timestamptz
);

CREATE INDEX push_subscriptions_user_idx ON push_subscriptions (user_id);
CREATE UNIQUE INDEX push_subscriptions_user_device_idx
  ON push_subscriptions (user_id, device_id);
