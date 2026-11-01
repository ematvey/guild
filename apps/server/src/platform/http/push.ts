// Web Push subscriptions. A member registers the browser that should receive
// notifications, removes it, and asks for a test. The VAPID public key is
// public by design: it only names this server to the push service.

import type { FastifyInstance } from "fastify";
import type { IdentityCtx } from "../route-contexts.js";
import type { PushNotifier } from "../../push/notifier.js";
import { ApiError, sortedJson } from "../errors.js";
import { requireJsonBody, requireUser } from "./error.js";

/** The VAPID public key is minted on first use, so the settings page can
 *  always ask for it without an admin step. */
export function registerPushRoutes(app: FastifyInstance, ctx: IdentityCtx, notifier: PushNotifier): void {
  app.get("/api/v1/push/config", async (req, reply) => {
    await requireUser(ctx, req);
    const keys = await ctx.pushKeys();
    return reply.status(200).send(sortedJson({ public_key: keys.publicKey }));
  });

  app.post("/api/v1/push/subscribe", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const body = requireJsonBody(req);
    const deviceId = text(body.device_id, "device_id", 200);
    const endpoint = text(body.endpoint, "endpoint", 2000);
    const keys = body.keys;
    if (keys === null || typeof keys !== "object" || Array.isArray(keys)) {
      throw ApiError.badRequest("keys must be an object with p256dh and auth");
    }
    const record = keys as Record<string, unknown>;
    const p256dh = text(record.p256dh, "keys.p256dh", 200);
    const auth = text(record.auth, "keys.auth", 200);
    const row = await ctx.push.upsert(user.org_id, user.id, {
      device_id: deviceId,
      endpoint,
      p256dh,
      auth,
      platform: typeof body.platform === "string" ? body.platform.slice(0, 40) : "web",
      user_agent: typeof req.headers["user-agent"] === "string" ? req.headers["user-agent"].slice(0, 400) : null,
    });
    return reply.status(200).send(sortedJson({ ok: true, id: row.id }));
  });

  app.post("/api/v1/push/unsubscribe", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const body = requireJsonBody(req);
    const endpoint = text(body.endpoint, "endpoint", 2000);
    const removed = await ctx.push.remove(user.id, endpoint);
    return reply.status(200).send(sortedJson({ ok: true, removed }));
  });

  /** One notification to every device this member registered. Answers with
   *  how many the push service accepted, so the page can say "sent" or "no
   *  device is registered". */
  app.post("/api/v1/push/test", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const delivered = await notifier.test(user.id);
    return reply.status(200).send(sortedJson({ ok: true, delivered }));
  });

  /** What this member has registered, for the settings page. Endpoints are
   *  capabilities: they never leave the server. */
  app.get("/api/v1/push/subscriptions", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const rows = await ctx.push.forUser(user.id);
    return reply.status(200).send(
      sortedJson({
        subscriptions: rows.map((row) => ({
          device_id: row.device_id,
          platform: row.platform,
          created_at: row.created_at,
          last_seen_at: row.last_seen_at,
          last_error: row.last_error,
        })),
      }),
    );
  });
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value === "") {
    throw ApiError.badRequest(`${field} must be a non-empty string`);
  }
  if (value.length > max) throw ApiError.badRequest(`${field} is too long`);
  return value;
}
