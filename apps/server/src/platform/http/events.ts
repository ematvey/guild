// Org events API (crates/server/src/http/events.rs): recent events are
// listed here; live delivery uses the authenticated WebSocket feed in
// crates/server/src/http/feed.rs (hub cutover, later milestone).

import type { FastifyInstance } from "fastify";
import type { IdentityCtx } from "../contexts.js";
import { sortedJson } from "../errors.js";
import { requireUser } from "./error.js";

export function registerEventRoutes(app: FastifyInstance, ctx: IdentityCtx): void {
  app.get("/api/v1/events", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const events = await ctx.events.list(user.org_id, 200);
    // json! interpolation — serde_json Value keys come out sorted.
    const rows = events.map((e) =>
      sortedJson({
        id: e.id,
        org_id: e.org_id,
        kind: e.kind,
        payload: e.payload,
        created_at: e.created_at,
      }),
    );
    return reply.status(200).send({ events: rows });
  });
}
