// Web Push: the device registry, the route surface, and the notifier's two
// rules (presence gate, one push per thread per window). The sender is faked
// so the test asserts what the server decides, not what a push service does.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { setupM2Stack, type M2Stack } from "./platform/m2-harness.js";
import { PushStore } from "../platform/store/push.js";
import { PushNotifier, pushTopic, turnEndedPayload } from "../push/notifier.js";
import { isPushServiceEndpoint, type PushResult, type PushSender } from "../push/sender.js";

let stack: M2Stack;
let store: PushStore;

beforeAll(async () => {
  stack = await setupM2Stack({}, { dbPrefix: "guild_push_test_" });
  store = new PushStore(stack.env.db);
});

afterAll(async () => {
  await stack?.env.cleanup();
});

const ROUTE_ENDPOINT = "https://fcm.googleapis.com/fcm/send/route-device";

const sub = (device: string, endpoint: string) => ({
  device_id: device,
  endpoint,
  p256dh: "p256dh-key",
  auth: "auth-secret",
});

/** Records every send; `gone` makes the endpoint look dead. */
function fakeSender(outcome: PushResult["outcome"] = "ok") {
  const sent: { endpoint: string; title: string; topic?: string }[] = [];
  const sender: PushSender = {
    async send(row, payload, topic) {
      sent.push({ endpoint: row.endpoint, title: payload.title, ...(topic === undefined ? {} : { topic }) });
      return outcome === "ok" ? { outcome } : { outcome, error: "gone" };
    },
  };
  return { sent, sender };
}

describe("the device registry", () => {
  it("keeps one row per device: a re-subscribe replaces the endpoint", async () => {
    const user = stack.memberId;
    await store.upsert(stack.orgId, user, sub("phone", "https://push/1"));
    await store.upsert(stack.orgId, user, sub("phone", "https://push/2"));
    const rows = await store.forUser(user);
    expect(rows.map((r) => r.endpoint)).toEqual(["https://push/2"]);
  });

  it("moves an endpoint to the account that subscribes last", async () => {
    await store.upsert(stack.orgId, stack.memberId, sub("shared", "https://push/shared"));
    await store.upsert(stack.orgId, stack.adminId, sub("shared", "https://push/shared"));
    expect((await store.forUser(stack.memberId)).map((r) => r.endpoint)).not.toContain("https://push/shared");
    expect((await store.forUser(stack.adminId)).map((r) => r.endpoint)).toContain("https://push/shared");
  });

  it("a member cannot delete another member's endpoint", async () => {
    await store.upsert(stack.orgId, stack.adminId, sub("admin", "https://push/admin"));
    expect(await store.remove(stack.memberId, "https://push/admin")).toBe(false);
    expect((await store.forUser(stack.adminId)).map((r) => r.endpoint)).toContain("https://push/admin");
  });

  it("a dead endpoint is deleted, a transient failure is recorded", async () => {
    await store.upsert(stack.orgId, stack.memberId, sub("dead", "https://push/dead"));
    await store.recordFailure("https://push/dead", "410 gone", true);
    expect((await store.forUser(stack.memberId)).map((r) => r.endpoint)).not.toContain("https://push/dead");

    await store.upsert(stack.orgId, stack.memberId, sub("flaky", "https://push/flaky"));
    await store.recordFailure("https://push/flaky", "503 busy", false);
    const row = (await store.forUser(stack.memberId)).find((r) => r.endpoint === "https://push/flaky");
    expect(row?.last_error).toBe("503 busy");
  });
});

/** A notifier whose chat log ends at `end` and whose owner has read
 *  through `read`, deciding without the production grace period. */
function notifierWith(sender: PushSender, end: number | null, read: number | null): PushNotifier {
  return new PushNotifier({
    store,
    lastEventSeq: async () => end,
    readSeq: async () => read,
    graceMs: 5,
    sender: async () => sender,
  });
}

describe("the notifier", () => {
  it("pushes nothing when the owner read the chat through the turn's end", async () => {
    const { sent, sender } = fakeSender();
    const notifier = notifierWith(sender, 12, 12);
    await store.upsert(stack.orgId, stack.memberId, sub("present", "https://push/present"));
    await notifier.turnEnded({ orgId: stack.orgId, userId: stack.memberId, chatId: "chat-1", title: "T", failed: false });
    expect(sent).toEqual([]);
  });

  it("pushes when the read marker stops before the turn's end", async () => {
    const { sent, sender } = fakeSender();
    const notifier = notifierWith(sender, 12, 9);
    await store.upsert(stack.orgId, stack.memberId, sub("behind", "https://push/behind"));
    await notifier.turnEnded({ orgId: stack.orgId, userId: stack.memberId, chatId: "chat-4", title: "T", failed: false });
    expect(sent.length).toBeGreaterThan(0);
  });

  it("sends one notification per thread per window", async () => {
    const { sent, sender } = fakeSender();
    const notifier = notifierWith(sender, 3, null);
    // One device, so one send per notification.
    for (const row of await store.forUser(stack.adminId)) await store.remove(stack.adminId, row.endpoint);
    await store.upsert(stack.orgId, stack.adminId, sub("away", "https://push/away"));
    const event = { orgId: stack.orgId, userId: stack.adminId, chatId: "chat-2", title: "Weekly", failed: false };
    await notifier.turnEnded(event);
    await notifier.turnEnded(event);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.topic).toBe(pushTopic("chat-2"));
    expect(sent[0]!.title).toBe("Weekly");
  });

  it("drops the row when the push service says the endpoint is gone", async () => {
    const { sender } = fakeSender("gone");
    const notifier = notifierWith(sender, 3, null);
    await store.upsert(stack.orgId, stack.adminId, sub("gone", "https://push/gone"));
    await notifier.turnEnded({ orgId: stack.orgId, userId: stack.adminId, chatId: "chat-3", title: "T", failed: true });
    expect((await store.forUser(stack.adminId)).map((r) => r.endpoint)).not.toContain("https://push/gone");
  });

  it("a test push skips the read check and reports how many were accepted", async () => {
    const { sent, sender } = fakeSender();
    const notifier = notifierWith(sender, 3, 3);
    const delivered = await notifier.test(stack.memberId);
    expect(delivered).toBeGreaterThan(0);
    expect(sent.length).toBe(delivered);
  });
});

describe("the payload", () => {
  it("collapses per chat within the push service's 32-character topic limit", () => {
    const topic = pushTopic("01a15f24-bbf2-7465-9921-bc78634717c1");
    expect(topic.length).toBeLessThanOrEqual(32);
    expect(topic).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(pushTopic("01a15f24-bbf2-7465-9921-bc78634717c1")).toBe(topic);
    expect(pushTopic("01a15f24-bbf2-7465-9921-bc78634717c2")).not.toBe(topic);
  });

  it("names the thread and how it ended, never the answer", () => {
    const done = turnEndedPayload({ orgId: "o", userId: "u", chatId: "c1", title: "Weekly", failed: false });
    expect(done).toMatchObject({ title: "Weekly", body: "The answer is ready.", url: "/thread/c1", chat_id: "c1" });
    const failed = turnEndedPayload({ orgId: "o", userId: "u", chatId: "c1", title: "", failed: true });
    expect(failed.body).toBe("The run failed.");
    expect(failed.title).toBe("Guild");
  });
});

describe("the route surface", () => {
  const auth = (token: string) => ({ authorization: `Bearer ${token}` });

  it("publishes the VAPID key to any member", async () => {
    const res = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/push/config",
      headers: auth(stack.memberToken),
    });
    expect(res.statusCode).toBe(200);
    expect((JSON.parse(res.body) as { public_key: string }).public_key.length).toBeGreaterThan(20);
  });

  it("registers and removes this member's device", async () => {
    const added = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/push/subscribe",
      headers: { ...auth(stack.memberToken), "content-type": "application/json" },
      payload: { device_id: "route-device", endpoint: ROUTE_ENDPOINT, keys: { p256dh: "k", auth: "a" } },
    });
    expect(added.statusCode).toBe(200);

    const listed = await stack.env.app.inject({
      method: "GET",
      url: "/api/v1/push/subscriptions",
      headers: auth(stack.memberToken),
    });
    const devices = (JSON.parse(listed.body) as { subscriptions: { device_id: string }[] }).subscriptions;
    expect(devices.map((d) => d.device_id)).toContain("route-device");
    // The endpoint is a capability: it never leaves the server.
    expect(listed.body).not.toContain(ROUTE_ENDPOINT);

    const removed = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/push/unsubscribe",
      headers: { ...auth(stack.memberToken), "content-type": "application/json" },
      payload: { endpoint: ROUTE_ENDPOINT },
    });
    expect(removed.statusCode).toBe(200);
    expect((JSON.parse(removed.body) as { removed: boolean }).removed).toBe(true);
  });

  it("rejects a subscription without keys", async () => {
    const res = await stack.env.app.inject({
      method: "POST",
      url: "/api/v1/push/subscribe",
      headers: { ...auth(stack.memberToken), "content-type": "application/json" },
      payload: { device_id: "d", endpoint: ROUTE_ENDPOINT },
    });
    expect(res.statusCode).toBe(400);
  });

  it("rejects an endpoint that is not a known push service", async () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/x",
      "https://169.254.169.254/latest/meta-data",
      "https://localhost/push",
      "https://fcm.googleapis.com:8443/fcm/send/x",
      "https://user:pw@fcm.googleapis.com/fcm/send/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://evilpush.apple.com.example/x",
      "not a url",
    ]) {
      const res = await stack.env.app.inject({
        method: "POST",
        url: "/api/v1/push/subscribe",
        headers: { ...auth(stack.memberToken), "content-type": "application/json" },
        payload: { device_id: "ssrf", endpoint, keys: { p256dh: "k", auth: "a" } },
      });
      expect(res.statusCode, endpoint).toBe(400);
    }
    expect((await store.forUser(stack.memberId)).some((r) => r.device_id === "ssrf")).toBe(false);
  });

  it("accepts every known push service host", () => {
    for (const endpoint of [
      "https://fcm.googleapis.com/fcm/send/abc",
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://api.push.apple.com/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      expect(isPushServiceEndpoint(endpoint), endpoint).toBe(true);
    }
  });
});
