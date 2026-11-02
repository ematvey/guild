// Teams: org subgroups used for cost roll-ups and scoping
//. Members carry the org's user list
// shape (UserListRow, same as admin users).

import { ApiError } from "../errors.js";
import { pgTimestampToRfc3339, utcText, uuidv7 } from "../time.js";
import type { PlatformPool } from "../db.js";
import type { UserListRow } from "./identity.js";

export type { UserListRow };

export interface TeamRow {
  id: string;
  org_id: string;
  name: string;
  created_at: string;
  member_count: number;
}

/** UserListRow declaration order —
 *  defined in identity.ts, re-exported here for the team-member lists. */

function teamRow(r: Record<string, unknown>): TeamRow {
  return {
    id: r.id as string,
    org_id: r.org_id as string,
    name: r.name as string,
    created_at: pgTimestampToRfc3339(r.created_at as string),
    member_count: Number(r.member_count),
  };
}

function userRow(r: Record<string, unknown>): UserListRow {
  return {
    id: r.id as string,
    email: r.email as string,
    role: r.role as string,
    identity_type: r.identity_type as string,
    created_at: pgTimestampToRfc3339(r.created_at as string),
  };
}

export class TeamStore {
  constructor(readonly pool: PlatformPool) {}

  async createTeam(orgId: string, name: string): Promise<TeamRow> {
    try {
      const res = await this.pool.query(
        "INSERT INTO teams (id, org_id, name) VALUES ($1, $2, $3) " +
          "RETURNING id, org_id, name, " +
          utcText("created_at") +
          " AS created_at, 0::bigint AS member_count",
        [uuidv7(), orgId, name],
      );
      return teamRow(res.rows[0]!);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw ApiError.conflict("team_taken", "a team with this name already exists");
      }
      throw error;
    }
  }

  async listTeams(orgId: string): Promise<TeamRow[]> {
    const res = await this.pool.query(
      "SELECT t.id, t.org_id, t.name, " +
        utcText("t.created_at") +
        " AS created_at, " +
        "COUNT(m.user_id)::bigint AS member_count " +
        "FROM teams t LEFT JOIN team_members m ON m.team_id = t.id " +
        "WHERE t.org_id = $1 GROUP BY t.id, t.org_id, t.name, t.created_at ORDER BY t.created_at",
      [orgId],
    );
    return res.rows.map((r: Record<string, unknown>) => teamRow(r));
  }

  async renameTeam(orgId: string, teamId: string, name: string): Promise<TeamRow> {
    if (!(await this.teamInOrg(orgId, teamId))) throw ApiError.notFound("no such team");
    try {
      const res = await this.pool.query(
        "UPDATE teams SET name = $1 WHERE id = $2 AND org_id = $3 " +
          "RETURNING id, org_id, name, " +
          utcText("created_at") +
          " AS created_at, " +
          "(SELECT COUNT(*) FROM team_members WHERE team_id = teams.id)::bigint AS member_count",
        [name, teamId, orgId],
      );
      return teamRow(res.rows[0]!);
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw ApiError.conflict("team_taken", "a team with this name already exists");
      }
      throw error;
    }
  }

  async deleteTeam(orgId: string, teamId: string): Promise<void> {
    const res = await this.pool.query("DELETE FROM teams WHERE id = $1 AND org_id = $2", [teamId, orgId]);
    if (res.rowCount === 0) throw ApiError.notFound("no such team");
  }

  /** Members of a team; the team must belong to the org. */
  async listMembers(orgId: string, teamId: string): Promise<UserListRow[]> {
    if (!(await this.teamInOrg(orgId, teamId))) throw ApiError.notFound("no such team");
    const res = await this.pool.query(
      "SELECT u.id, u.email, u.role, u.identity_type, " +
        utcText("u.created_at") +
        " AS created_at " +
        "FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = $1 ORDER BY u.created_at",
      [teamId],
    );
    return res.rows.map((r: Record<string, unknown>) => userRow(r));
  }

  async addMember(orgId: string, teamId: string, userId: string): Promise<void> {
    if (!(await this.teamInOrg(orgId, teamId))) throw ApiError.notFound("no such team");
    const res = await this.pool.query("SELECT org_id FROM users WHERE id = $1", [userId]);
    if (res.rows[0]?.org_id !== orgId) throw ApiError.badRequest("user is not in this org");
    await this.pool.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING", [
      teamId,
      userId,
    ]);
  }

  async removeMember(orgId: string, teamId: string, userId: string): Promise<void> {
    if (!(await this.teamInOrg(orgId, teamId))) throw ApiError.notFound("no such team");
    await this.pool.query("DELETE FROM team_members WHERE team_id = $1 AND user_id = $2", [teamId, userId]);
  }

  /** Whether the user is on the team (the publish gate's membership check). */
  async isMember(orgId: string, teamId: string, userId: string): Promise<boolean> {
    const res = await this.pool.query(
      "SELECT 1::int8 FROM team_members m JOIN teams t ON t.id = m.team_id " +
        "WHERE t.org_id = $1 AND t.id = $2 AND m.user_id = $3",
      [orgId, teamId, userId],
    );
    return res.rows.length > 0;
  }

  /** The user's teams in the org (the skill editor's owner selector). */
  async listTeamsForUser(orgId: string, userId: string): Promise<Array<{ id: string; name: string }>> {
    const res = await this.pool.query(
      "SELECT t.id, t.name FROM team_members m JOIN teams t ON t.id = m.team_id " +
        "WHERE t.org_id = $1 AND m.user_id = $2 ORDER BY t.name",
      [orgId, userId],
    );
    return res.rows.map((r: Record<string, unknown>) => ({ id: r.id as string, name: r.name as string }));
  }

  private async teamInOrg(orgId: string, teamId: string): Promise<boolean> {
    const res = await this.pool.query("SELECT org_id FROM teams WHERE id = $1", [teamId]);
    return res.rows[0]?.org_id === orgId;
  }
}
