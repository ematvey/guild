// Agent visibility and grant roles: the one predicate every visibility-
// filtered read applies, the caller's role on one agent, and the bulk
// reads the member socket scopes its agent frames by.

import type { PlatformPool } from "../../platform/db.js";
import type { UserRow } from "../../platform/store/identity.js";
import type { Agent, AgentAccess, AgentRole } from "../types.js";
import { GRANT_ROLE } from "../types.js";

/** The viewer columns of the visibility predicate: SQL expressions for the
 *  org id, whether the viewer is an admin, and the viewer's user id. */
export interface ViewerSql {
  org: string;
  admin: string;
  user: string;
}

/** The fixed placeholders a single-viewer read binds: $1 = org id,
 *  $2 = caller is admin, $3 = caller user id. */
export const VIEWER_PARAMS: ViewerSql = { org: "$1", admin: "$2::boolean", user: "$3" };

/** The viewer columns of a `users` alias. */
export function userViewer(alias: string): ViewerSql {
  return { org: `${alias}.org_id`, admin: `(${alias}.role = 'admin')`, user: `${alias}.id` };
}

/** Visibility predicate over an `agents` alias. A personal agent belongs to
 *  exactly one user: no admin override, no org or team visibility.
 *  Everything else follows the grant rules. */
export function visiblePredicate(alias: string, viewer: ViewerSql = VIEWER_PARAMS): string {
  return `(${alias}.org_id = ${viewer.org} AND (
    ${alias}.owner_user_id = ${viewer.user}
    OR (${alias}.is_personal = false AND (
      ${viewer.admin}
      OR ${alias}.visibility = 'org'
      OR EXISTS (SELECT 1 FROM agent_grants g
        WHERE g.agent_id = ${alias}.id AND g.user_id = ${viewer.user} AND g.role = '${GRANT_ROLE}')
      OR (${alias}.visibility = 'team' AND EXISTS (
        SELECT 1 FROM agent_team_grants tg
        JOIN team_members tm ON tm.team_id = tg.team_id
        WHERE tg.agent_id = ${alias}.id AND tm.user_id = ${viewer.user} AND tg.role = '${GRANT_ROLE}'))
    ))
  ))`;
}

function accessForRole(
  role: AgentRole | null,
  canManage: boolean,
  canUse: boolean = role !== null || canManage,
): AgentAccess {
  return { role, can_manage: canManage, can_use: canUse };
}

export class AgentGrants {
  constructor(private readonly pool: PlatformPool) {}

  /** The caller's grant role and capability flags for one agent. Admins
   *  resolve as owner. */
  async access(user: UserRow, agent: Agent): Promise<AgentAccess> {
    if (user.role === "admin" || agent.owner_user_id === user.id) {
      return accessForRole("owner", true);
    }
    // Only a `user` grant confers use; a row with any other role is ignored.
    const granted = await this.pool.query(
      `SELECT 1 FROM agent_grants WHERE agent_id = $1 AND user_id = $2 AND role = $3
       UNION ALL
       SELECT 1 FROM agent_team_grants tg
       JOIN team_members tm ON tm.team_id = tg.team_id
       WHERE tg.agent_id = $1 AND tm.user_id = $2 AND tg.role = $3
       LIMIT 1`,
      [agent.id, user.id, GRANT_ROLE],
    );
    if (granted.rows.length > 0) return accessForRole(GRANT_ROLE, false);
    if (agent.visibility === "org") return accessForRole(null, false, true);
    return accessForRole(null, false);
  }

  /** The users among `userIds` who may see the agent: the list's predicate,
   *  evaluated per user. */
  async visibleUserIds(agentId: string, userIds: readonly string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const res = await this.pool.query<{ id: string }>(
      `SELECT u.id FROM users u JOIN agents a ON a.id = $1
       WHERE u.id = ANY($2::uuid[])
         AND ${visiblePredicate("a", userViewer("u"))}`,
      [agentId, userIds],
    );
    return res.rows.map((row) => row.id);
  }
}
