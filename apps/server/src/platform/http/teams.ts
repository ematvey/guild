// Team admin: org subgroups
// used for cost roll-ups and scoping.

import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { IdentityCtx } from "../route-contexts.js";
import { ApiError } from "../errors.js";
import { parseUuidParam, requireUser } from "./error.js";
import { rustJsonText } from "../provider/sse.js";

function sendJson(reply: FastifyReply, value: unknown): void {
  void reply.type("application/json").send(rustJsonText(value));
}

export function registerTeamRoutes(app: FastifyInstance, ctx: IdentityCtx): void {
  app.get("/api/v1/admin/teams", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    const teams = await ctx.teams.listTeams(admin.org_id);
    sendJson(reply, { teams });
    return reply;
  });

  app.post("/api/v1/admin/teams", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    const name = readName(req);
    const team = await ctx.teams.createTeam(admin.org_id, name);
    sendJson(reply, { id: team.id, name: team.name });
    return reply;
  });

  app.put("/api/v1/admin/teams/:id", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    const name = readName(req);
    const team = await ctx.teams.renameTeam(admin.org_id, parseUuidParam(req, "id"), name);
    sendJson(reply, { id: team.id, name: team.name });
    return reply;
  });

  app.delete("/api/v1/admin/teams/:id", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    await ctx.teams.deleteTeam(admin.org_id, parseUuidParam(req, "id"));
    sendJson(reply, {});
    return reply;
  });

  app.get("/api/v1/admin/teams/:id/members", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    const members = await ctx.teams.listMembers(admin.org_id, parseUuidParam(req, "id"));
    sendJson(reply, { members });
    return reply;
  });

  app.post("/api/v1/admin/teams/:id/members", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    const record = (req.body !== null && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
    const userIdRaw = record["user_id"];
    if (typeof userIdRaw !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(userIdRaw)) {
      throw ApiError.badRequest("missing user_id");
    }
    await ctx.teams.addMember(admin.org_id, parseUuidParam(req, "id"), userIdRaw.toLowerCase());
    sendJson(reply, {});
    return reply;
  });

  app.delete("/api/v1/admin/teams/:id/members/:userId", async (req, reply) => {
    const admin = await requireAdmin(ctx, req);
    await ctx.teams.removeMember(admin.org_id, parseUuidParam(req, "id"), parseUuidParam(req, "userId"));
    sendJson(reply, {});
    return reply;
  });
}

function readName(req: FastifyRequest): string {
  const record = (req.body !== null && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
  const name = record["name"];
  if (typeof name !== "string") throw ApiError.badRequest("missing name");
  return name;
}

async function requireAdmin(ctx: IdentityCtx, req: FastifyRequest) {
  const user = await requireUser(ctx, req);
  if (user.role !== "admin") throw ApiError.forbidden();
  return user;
}
