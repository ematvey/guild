// Machine registry routes: the machines list (the snapshot the member
// socket's machine_list frame carries), the owner-scoped control-plane fs
// ops the desktop UI drives directly, and deauthorization (forget the
// machine and revoke the session it paired with). Pairing routes live in
// the auth lane (/api/v1/auth/pair*); there is no rename route — the label
// comes from the daemon's upgrade query.

import type { FastifyInstance } from "fastify";
import type { ChatsCtx, IdentityCtx } from "../route-contexts.js";
import { ApiError } from "../errors.js";
import { parseUuidParam, requireJsonBody, requireUser } from "./error.js";
import { machineListSnapshot } from "../../hub/workspace.js";

export function registerMachineRoutes(app: FastifyInstance, chats: ChatsCtx, ctx: IdentityCtx): void {
  /** Lists the calling user's machines: every durable registry row plus the
   *  hub's live socket flag, connected machines first, then by last seen. */
  app.get("/api/v1/machines", async (req) => {
    const user = await requireUser(ctx, req);
    return { machines: await machineListSnapshot(chats, user) };
  });

  /** Deauthorizes a machine: drops its registry row, unbinds the chats that
   *  ran on it (they fall back to the server executor), revokes the session
   *  it paired with — so the app cannot sign back in and re-register — and
   *  closes its live socket. A machine with bound projects refuses (409):
   *  their files live there, and moving them is the user's decision. */
  app.delete("/api/v1/machines/:id", async (req) => {
    const user = await requireUser(ctx, req);
    const machineId = parseUuidParam(req, "id");
    const result = await chats.machines.deauthorize(user.org_id, user.id, machineId);
    if (result.kind === "missing") throw ApiError.notFound("no such machine");
    if (result.kind === "blocked") {
      throw ApiError.conflict(
        "machine_has_projects",
        `this machine has projects bound to it: ${result.projects.join(", ")} — delete them first`,
      );
    }
    chats.hub.displaceMachine(machineId);
    if (result.session_hash !== null) {
      await ctx.identity.revokeSessionHash(result.session_hash);
    }
    return { ok: true };
  });

  /** Control-plane request to a machine's executor socket, owner-scoped:
   *  read-only filesystem ops the desktop UI drives directly (folder browse
   *  for remote projects). `op`: `fs_list` (payload `{path}`), `fs_home`. */
  app.post("/api/v1/machines/:id/fs", async (req) => {
    const user = await requireUser(ctx, req);
    const machineId = parseUuidParam(req, "id");
    const body = requireJsonBody(req);
    const owned = (await chats.machines.listForUser(user.org_id, user.id)).some((m) => m.machine_id === machineId);
    if (!owned) throw ApiError.notFound("no such machine");
    const op = typeof body["op"] === "string" ? body["op"] : "";
    const payload = body["payload"] ?? null;
    if (op !== "fs_list" && op !== "fs_home") {
      throw ApiError.badRequest("unknown op");
    }
    const result = await chats.hub.machineRequest(machineId, user.org_id, op, payload, 10_000);
    if (result.ok) return { ok: true, result: result.value };
    const error = result.error;
    if (error.kind === "rejected") throw ApiError.internal(error.message ?? "machine refused");
    if (error.kind === "offline" || error.kind === "send_failed") {
      throw ApiError.internal(error.kind === "offline" ? "machine offline" : "machine unreachable");
    }
    throw ApiError.internal("machine did not answer");
  });
}
