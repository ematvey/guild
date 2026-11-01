// Web Push device registry: one row per browser/device that asked for
// notifications. The endpoint is the browser's push-service URL and the keys
// encrypt the payload; the sender deletes a row when the push service says
// the endpoint is gone (404/410), so stale devices do not accumulate.

import { withTransaction, type PlatformPool } from "../db.js";
import { uuidv7 } from "../time.js";

export interface PushSubscriptionRow {
  id: string;
  org_id: string;
  user_id: string;
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  platform: string;
  created_at: string;
  last_seen_at: string;
  last_error: string | null;
  failed_at: string | null;
}

const COLUMNS =
  "id, org_id, user_id, device_id, endpoint, p256dh, auth, platform, " +
  "to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at, " +
  "to_char(last_seen_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS last_seen_at, " +
  "last_error, " +
  "to_char(failed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS failed_at";

/** What a browser sends when it subscribes. */
export interface PushSubscriptionInput {
  device_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  platform?: string;
  user_agent?: string | null;
}

export class PushStore {
  constructor(readonly pool: PlatformPool) {}

  /** Registers or refreshes one device. The device id and the endpoint are
   *  both unique: a re-subscribe with a new endpoint replaces the old row
   *  for that device, and an endpoint already owned by another user moves to
   *  the caller (a shared browser that switched accounts). */
  async upsert(orgId: string, userId: string, input: PushSubscriptionInput): Promise<PushSubscriptionRow> {
    return withTransaction(this.pool, async (client) => {
      // This device's previous endpoint is dead by definition (the browser
      // minted a new one). It must go first: the (user, device) unique index
      // would otherwise reject the insert.
      await client.query(
        "DELETE FROM push_subscriptions WHERE user_id = $1 AND device_id = $2 AND endpoint <> $3",
        [userId, input.device_id, input.endpoint],
      );
      const res = await client.query<PushSubscriptionRow>(
      `INSERT INTO push_subscriptions
         (id, org_id, user_id, device_id, endpoint, p256dh, auth, platform, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (endpoint) DO UPDATE SET
         org_id = EXCLUDED.org_id,
         user_id = EXCLUDED.user_id,
         device_id = EXCLUDED.device_id,
         p256dh = EXCLUDED.p256dh,
         auth = EXCLUDED.auth,
         platform = EXCLUDED.platform,
         user_agent = EXCLUDED.user_agent,
         last_seen_at = now(),
         last_error = NULL,
         failed_at = NULL
       RETURNING ${COLUMNS}`,
        [
          uuidv7(),
          orgId,
          userId,
          input.device_id,
          input.endpoint,
          input.p256dh,
          input.auth,
          input.platform ?? "web",
          input.user_agent ?? null,
        ],
      );
      return res.rows[0]!;
    });
  }

  /** Removes one endpoint. Scoped to the caller: an endpoint is a capability,
   *  and a member cannot delete another member's row. */
  async remove(userId: string, endpoint: string): Promise<boolean> {
    const res = await this.pool.query(
      "DELETE FROM push_subscriptions WHERE user_id = $1 AND endpoint = $2",
      [userId, endpoint],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** The push service said the endpoint is gone: drop it. */
  async removeByEndpoint(endpoint: string): Promise<void> {
    await this.pool.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [endpoint]);
  }

  async forUser(userId: string): Promise<PushSubscriptionRow[]> {
    const res = await this.pool.query<PushSubscriptionRow>(
      `SELECT ${COLUMNS} FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at`,
      [userId],
    );
    return res.rows;
  }

  /** Records a failed send. `permanent` (404/410) deletes the row; anything
   *  else keeps it with the error for the settings page. */
  async recordFailure(endpoint: string, message: string, permanent: boolean): Promise<void> {
    if (permanent) {
      await this.removeByEndpoint(endpoint);
      return;
    }
    await this.pool.query(
      "UPDATE push_subscriptions SET last_error = $2, failed_at = now() WHERE endpoint = $1",
      [endpoint, message.slice(0, 200)],
    );
  }

  async markSeen(endpoint: string): Promise<void> {
    await this.pool.query(
      "UPDATE push_subscriptions SET last_seen_at = now(), last_error = NULL, failed_at = NULL WHERE endpoint = $1",
      [endpoint],
    );
  }
}
