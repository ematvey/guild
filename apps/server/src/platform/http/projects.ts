// Project routes: CRUD over the
// caller's named workspace folders. Strictly owner-scoped (admins
// included); names are display labels derived from the folder when omitted
// — duplicates are allowed.

import type { FastifyInstance } from "fastify";
import type { GatewayCtx, IdentityCtx } from "../route-contexts.js";
import { ApiError } from "../errors.js";
import { optionalJsonBody, parseUuidParam, queryParam, requireUser, sendJson } from "./error.js";
import type { ProjectRow } from "../store/projects.js";
import type { Project } from "@guild/wire/rest";

/** The display name for a folder: its last path segment (Windows or POSIX
 *  separators); a drive or share root names itself. */
export function folderBasename(folder: string): string {
  const trimmed = folder.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/).filter((seg) => seg !== "");
  return segments.length > 0 ? segments[segments.length - 1]! : trimmed;
}

/** serde struct order for the protocol Project type (direct Json<Project>
 *  responses serialize in declaration order, not sorted). */
function projectJson(p: ProjectRow): string {
  const out: Project = {
    id: p.id,
    name: p.name,
    folder: p.folder,
    machine_id: p.machine_id,
    machine_label: p.machine_label,
    created_at: p.created_at,
  };
  return JSON.stringify(out);
}

export function registerProjectRoutes(app: FastifyInstance, gateway: GatewayCtx, ctx: IdentityCtx): void {
  app.post("/api/v1/projects", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const record = optionalJsonBody(req);
    const folderRaw = typeof record["folder"] === "string" ? record["folder"] : undefined;
    if (folderRaw === undefined) throw ApiError.badRequest("folder must be a string");
    const machineIdRaw = typeof record["machine_id"] === "string" ? record["machine_id"] : undefined;
    if (machineIdRaw === undefined) throw ApiError.badRequest("machine_id must be a string");
    const folder = folderRaw.trim();
    if (folder === "" || machineIdRaw === "") {
      throw ApiError.badRequest("folder and machine_id are required");
    }
    const nameOpt = typeof record["name"] === "string" ? record["name"].trim() : null;
    const name = nameOpt !== null && nameOpt !== "" ? nameOpt : folderBasename(folder);
    const created = await gateway.projects.create(user.org_id, user.id, name, folder, machineIdRaw);
    return reply.status(200).type("application/json").send(projectJson(created));
  });

  app.get("/api/v1/projects", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const archived = ["1", "true"].includes(queryParam(req, "archived") ?? "");
    const rows = archived
      ? await gateway.projects.listArchived(user.org_id, user.id)
      : await gateway.projects.list(user.org_id, user.id);
    sendJson(reply, { projects: rows });
    return reply;
  });

  app.put("/api/v1/projects/:id", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const projectId = parseUuidParam(req, "id");
    const record = optionalJsonBody(req);
    const name = typeof record["name"] === "string" && record["name"].trim() !== "" ? record["name"].trim() : null;
    const folder =
      typeof record["folder"] === "string" && record["folder"].trim() !== "" ? record["folder"].trim() : null;
    let machineId: string | null = null;
    if (record["machine_id"] !== undefined && record["machine_id"] !== null) {
      if (typeof record["machine_id"] !== "string") {
        throw ApiError.badRequest("machine_id must be a string");
      }
      if (record["machine_id"] === "") throw ApiError.badRequest("unknown machine");
      machineId = record["machine_id"];
    }
    let archived: boolean | null = null;
    if (record["archived"] !== undefined && record["archived"] !== null) {
      if (typeof record["archived"] !== "boolean") {
        throw ApiError.badRequest("archived must be a boolean");
      }
      archived = record["archived"];
    }
    const updated = await gateway.projects.update(user.org_id, projectId, user.id, name, folder, machineId, archived);
    return reply.status(200).type("application/json").send(projectJson(updated));
  });

  app.delete("/api/v1/projects/:id", async (req, reply) => {
    const user = await requireUser(ctx, req);
    const projectId = parseUuidParam(req, "id");
    await gateway.projects.delete(user.org_id, projectId, user.id);
    sendJson(reply, { ok: true });
    return reply;
  });
}
