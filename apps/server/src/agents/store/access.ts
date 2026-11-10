// Agent access (docs/domain/002-access.md, "Agents"): the caller's level on
// one agent, and the bulk reads the member socket scopes its agent frames by.
// The entries themselves live in `agent_access` and the predicate is the
// shared one, so an Agent and an App answer "who may reach this" the same way.

import type { PlatformPool } from "../../platform/db.js";
import type { UserRow } from "../../platform/store/identity.js";
import type { AccessLevel, AccessStore } from "../../platform/store/access.js";
import {
  accessPredicate,
  editPredicate,
  userViewer,
  type ViewerSql,
} from "../../platform/store/access.js";
import type { Agent, AgentAccess, AgentRole } from "../types.js";

/** Visibility-filtered agent reads bind the viewer as $1 = org id,
 *  $2 = caller is admin, $3 = caller user id. */
export const visiblePredicate = (alias: string, viewer?: ViewerSql): string =>
  accessPredicate("agent", alias, viewer);

/** The managing viewer's agent reads also bind the edit entry. */
export const editablePredicate = (alias: string): string =>
  editPredicate("agent", alias);

function accessForLevel(level: AccessLevel | null): AgentAccess {
  if (level === "edit") {
    return { role: "editor", can_manage: true, can_use: true };
  }
  if (level === "read") {
    return { role: "user", can_manage: false, can_use: true };
  }
  return { role: null, can_manage: false, can_use: false };
}

export class AgentGrants {
  constructor(
    private readonly pool: PlatformPool,
    private readonly accessStore: AccessStore,
  ) {}

  /** The caller's role and capability flags for one agent. The owner and an
   *  admin manage it; an `edit` entry manages it; a `read` entry or `org`
   *  visibility uses it. */
  async access(user: UserRow, agent: Agent): Promise<AgentAccess> {
    if (user.role === "admin" || agent.owner_user_id === user.id) {
      return {
        role: "owner" satisfies AgentRole,
        can_manage: true,
        can_use: true,
      };
    }
    return accessForLevel(
      await this.accessStore.level("agent", agent.id, user),
    );
  }

  /** The users among `userIds` who may see the agent: the list's predicate,
   *  evaluated per user. */
  async visibleUserIds(
    agentId: string,
    userIds: readonly string[],
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const res = await this.pool.query<{ id: string }>(
      `SELECT u.id FROM users u JOIN agents a ON a.id = $1
       WHERE u.id = ANY($2::uuid[])
         AND ${visiblePredicate("a", userViewer("u"))}`,
      [agentId, userIds],
    );
    return res.rows.map((row) => row.id);
  }

  /** For each of `userIds` in the org, the ids of the org's agents that user
   *  may see and their level on each, in one read. A user outside the org, or
   *  one who sees nothing, maps to an empty map. */
  async visibleAgentIds(
    orgId: string,
    userIds: readonly string[],
  ): Promise<Map<string, Map<string, AccessLevel>>> {
    return this.accessStore.visibleIds(orgId, "agent", userIds);
  }
}
