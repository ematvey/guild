// Org API keys for the public OpenAI-compatible endpoint (crates/server/
// src/http/api_keys.rs port): admin-minted org keys plus user-level keys
// every member manages from their own settings.

import type { FastifyInstance, FastifyRequest } from "fastify";
import { ApiError } from "../errors.js";
import { parseUuidParam, requireJsonBody, requireUser } from "./error.js";
import type { PlatformContext } from "../context.js";
import { rustJsonText } from "../provider/sse.js";

/** The authenticated user from the session table, requiring the admin role. */
async function requireAdminUser(ctx: PlatformContext, req: FastifyRequest) {
  const user = await requireUser(ctx, req);
  if (user.role !== "admin") throw ApiError.forbidden();
  return user;
}

export function registerApiKeyRoutes(app: FastifyInstance, ctx: PlatformContext): void {
  app.post("/api/v1/admin/api-keys", async (req) => {
    const admin = await requireAdminUser(ctx, req);
    const body = requireJsonBody(req);
    const name = typeof body["name"] === "string" ? body["name"] : "api key";
    const created = await ctx.apiKeys.create(
      admin.org_id,
      admin.id,
      name,
      null,
      admin.session_generation ?? null,
    );
    return rustJsonText({ key: created.key, plaintext: created.plaintext });
  });

  app.get("/api/v1/admin/api-keys", async (req) => {
    const admin = await requireAdminUser(ctx, req);
    const keys = await ctx.apiKeys.list(admin.org_id);
    return rustJsonText({ keys });
  });

  app.delete("/api/v1/admin/api-keys/:id", async (req) => {
    const admin = await requireAdminUser(ctx, req);
    await ctx.apiKeys.revoke(admin.org_id, parseUuidParam(req, "id"));
    return rustJsonText({});
  });

  // User-level: every member manages their own gateway keys from settings.
  app.post("/api/v1/api-keys", async (req) => {
    const user = await requireUser(ctx, req);
    const body = requireJsonBody(req);
    const name = typeof body["name"] === "string" ? body["name"] : "api key";
    const created = await ctx.apiKeys.create(
      user.org_id,
      user.id,
      name,
      user.id,
      user.session_generation ?? null,
    );
    return rustJsonText({ key: created.key, plaintext: created.plaintext });
  });

  app.get("/api/v1/api-keys", async (req) => {
    const user = await requireUser(ctx, req);
    const keys = await ctx.apiKeys.listForUser(user.id);
    return rustJsonText({ keys });
  });

  app.delete("/api/v1/api-keys/:id", async (req) => {
    const user = await requireUser(ctx, req);
    await ctx.apiKeys.revokeOwned(user.id, parseUuidParam(req, "id"));
    return rustJsonText({});
  });
}
