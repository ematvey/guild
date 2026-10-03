// Machine registry routes (crates/server/src/http/chats.rs, machine parts):
// the machines page list and the owner-scoped control-plane fs ops the
// desktop UI drives directly. Pairing routes live in the auth lane
// (/api/v1/auth/pair*, already native); there are no rename/delete routes
// server-side — the label comes from the daemon's upgrade query, and
// unpairing is registry adoption (re-pair) or manual row surgery.

import type { FastifyInstance } from "fastify";
import type { PlatformContext } from "../platform/context.js";
import { ApiError, parseUuidParam, requireJsonBody, requireUser } from "../platform/http/error.js";
import type { MachineRow } from "../platform/store/machines.js";

/** MachineInfo wire shape. The Rust handler serializes each row through
 *  json! (serde_json Value → BTreeMap), so key order is ALPHABETICAL —
 *  verified against the captured Rust frames (ws-golden.json). */
function machineInfo(row: MachineRow, connected: boolean): Record<string, unknown> {
  return {
    ...(row.app_version !== null ? { app_version: row.app_version } : {}),
    connected,
    first_connected_at: row.first_connected_at,
    last_connected_at: row.last_connected_at,
    ...(row.last_ip !== null ? { last_ip: row.last_ip } : {}),
    last_seen_at: row.last_seen_at,
    machine_id: row.machine_id,
    name: row.label !== null && row.label !== "" ? row.label : row.machine_id,
    ...(row.os !== null ? { os: row.os } : {}),
    ...(row.os_version !== null ? { os_version: row.os_version } : {}),
  };
}

export function registerMachineRoutes(app: FastifyInstance, ctx: PlatformContext): void {
  /** Lists the calling user's machines: every durable registry row plus the
   *  hub's live socket flag, connected machines first, then by last seen. */
  app.get("/api/v1/machines", async (req) => {
    const user = await requireUser(ctx, req);
    const rows = await ctx.machines.listForUser(user.org_id, user.id);
    const list = rows.map((row) => machineInfo(row, ctx.hub.machineOnline(row.machine_id)));
    list.sort((a, b) => {
      const connectedCmp = (b.connected as boolean ? 1 : 0) - (a.connected as boolean ? 1 : 0);
      if (connectedCmp !== 0) return connectedCmp;
      return (
        Date.parse(b.last_seen_at as string) - Date.parse(a.last_seen_at as string)
      );
    });
    return { machines: list };
  });

  /** Control-plane request to a machine's executor socket, owner-scoped:
   *  read-only filesystem ops the desktop UI drives directly (folder browse
   *  for remote projects). `op`: `fs_list` (payload `{path}`), `fs_home`. */
  app.post("/api/v1/machines/:id/fs", async (req) => {
    const user = await requireUser(ctx, req);
    const machineId = parseUuidParam(req, "id");
    const body = requireJsonBody(req);
    const owned = (await ctx.machines.listForUser(user.org_id, user.id)).some(
      (m) => m.machine_id === machineId,
    );
    if (!owned) throw ApiError.notFound("no such machine");
    const op = typeof body["op"] === "string" ? body["op"] : "";
    const payload = body["payload"] ?? null;
    if (op !== "fs_list" && op !== "fs_home") {
      throw ApiError.badRequest("unknown op");
    }
    const result = await ctx.hub.machineRequest(machineId, user.org_id, op, payload, 10_000);
    if (result.ok) return { ok: true, result: result.value };
    const error = result.error;
    if (error.kind === "rejected") throw ApiError.internal(error.message ?? "machine refused");
    if (error.kind === "offline" || error.kind === "send_failed") {
      throw ApiError.internal(error.kind === "offline" ? "machine offline" : "machine unreachable");
    }
    throw ApiError.internal("machine did not answer");
  });
}
