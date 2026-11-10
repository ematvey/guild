// Access (docs/domain/002-access.md, "Access"): one list per item of who may
// reach it and how. Agents and Apps share the route and the wire shape; the
// caller supplies the two checks — who may read the item, and who may change
// its list — so the route itself knows nothing about either kind.

import type { FastifyInstance } from "fastify";
import type { IdentityCtx } from "../route-contexts.js";
import { ApiError } from "../errors.js";
import { parseUuidParam, requireUser, sendJson } from "./error.js";
import { parseAccessKind, parseAccessInput } from "../domain/access-list.js";
import type { AccessKind, AccessStore, AccessLevel } from "../store/access.js";
import type { UserRow } from "../store/identity.js";

/** What one item kind must answer for the shared route. */
export interface AccessGuards {
  /** The caller's level on the item, or null when they cannot see it. */
  level: (user: UserRow, id: string) => Promise<AccessLevel | null>;
  /** Refuses a caller who may not change the item's list. */
  manage: (user: UserRow, id: string) => Promise<void>;
}

export function registerAccessRoutes(
  app: FastifyInstance,
  auth: IdentityCtx,
  access: AccessStore,
  guards: Record<AccessKind, AccessGuards>,
): void {
  // `GET /api/v1/access/{kind}/{id}` — the item's entries as the viewer may
  // read them, and whether the viewer may change them.
  app.get("/api/v1/access/:kind/:id", async (req, reply) => {
    const user = await requireUser(auth, req);
    const kind = parseAccessKind(
      (req.params as Record<string, string>)["kind"],
    );
    const id = parseUuidParam(req, "id");
    const level = await guards[kind].level(user, id);
    if (level === null) throw ApiError.notFound(`no such ${kind}`);
    return sendJson(reply, {
      entries: await access.entries(user.org_id, kind, id),
      can_edit: level === "edit",
    });
  });

  // `PUT /api/v1/access/{kind}/{id}` — replaces the item's whole list. Body:
  // `{"entries": [{"subject_kind", "subject_id", "level"}]}`. The org entry
  // is the item's `visibility`; the rest are named Members and Teams.
  app.put("/api/v1/access/:kind/:id", async (req, reply) => {
    const user = await requireUser(auth, req);
    const kind = parseAccessKind(
      (req.params as Record<string, string>)["kind"],
    );
    const id = parseUuidParam(req, "id");
    await guards[kind].manage(user, id);
    await access.replace(user.org_id, kind, id, parseAccessInput(req.body));
    return sendJson(reply, {
      entries: await access.entries(user.org_id, kind, id),
      can_edit: true,
    });
  });

  // `GET /api/v1/access/people` — the org's Members, for the picker.
  app.get("/api/v1/access/people", async (req, reply) => {
    const user = await requireUser(auth, req);
    return sendJson(reply, { people: await access.people(user.org_id) });
  });
}
