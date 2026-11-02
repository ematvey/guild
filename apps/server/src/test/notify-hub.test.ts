import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { NotifyHub } from "../platform/notify.js";
import { TEST_ADMIN_URL } from "./support/platform-env.js";
import { waitFor } from "./support/wait.js";

function until(cond: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  return waitFor(cond, timeoutMs, 20, "condition not met in time");
}

describe("NotifyHub", () => {
  const appName = `notify-hub-test-${process.pid}`;
  const url = new URL(TEST_ADMIN_URL);
  url.searchParams.set("application_name", appName);
  const hub = new NotifyHub(url.toString());
  const admin = new pg.Client({ connectionString: TEST_ADMIN_URL });

  afterAll(async () => {
    await hub.close();
    await admin.end().catch(() => {});
  });

  it("tells subscribers to resync after the LISTEN connection is restored", async () => {
    await admin.connect();
    const payloads: string[] = [];
    let reconnects = 0;
    hub.subscribe(
      (channel, payload) => {
        if (channel === "guild_workspace_identity") payloads.push(payload);
      },
      () => {
        reconnects += 1;
      },
    );
    const marker = `first-${Date.now()}`;
    await until(async () => {
      await admin.query("SELECT pg_notify('guild_workspace_identity', $1)", [marker]);
      return payloads.includes(marker);
    });
    expect(reconnects).toBe(0);

    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity
       WHERE application_name = $1`,
      [appName],
    );
    await until(() => reconnects === 1);

    const after = `second-${Date.now()}`;
    await until(async () => {
      await admin.query("SELECT pg_notify('guild_workspace_identity', $1)", [after]);
      return payloads.includes(after);
    });
  });
});
