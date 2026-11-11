// Access storage (docs/domain/002-access.md, "Access"): one item's list of who
// may reach it and how. Agents and Apps keep the same rows in their own
// tables (`agent_access`, `app_access`), so one predicate, one wire shape and
// one route serve both. An item's `visibility = 'org'` is the "everyone"
// entry; every other entry is a named Member or Team with a level. `read`
// sees and uses the item; `edit` manages it.

import { ApiError } from "../errors.js";
import { withTransaction, type PlatformPool } from "../db.js";
import type { UserRow } from "./identity.js";

export type AccessKind = "agent" | "app";
export type AccessLevel = "read" | "edit";
export type AccessSubjectKind = "org" | "team" | "user";

/** One entry as the wire carries it. `subject_id` is null for `org`. */
export interface AccessEntry {
  subject_kind: AccessSubjectKind;
  subject_id: string | null;
  subject_label: string;
  level: AccessLevel;
}

/** One entry as a writer sends it: the label is the server's to resolve. */
export interface AccessInput {
  subject_kind: AccessSubjectKind;
  subject_id: string | null;
  level: AccessLevel;
}

/** One member a picker offers: the org's people, by name. */
export interface AccessPerson {
  id: string;
  label: string;
  avatar_url: string | null;
}

/** One team a picker offers: every team of the org, by name. */
export interface AccessTeam {
  id: string;
  label: string;
}

/** The viewer columns of the visibility predicate: SQL expressions for the
 *  org id, whether the viewer is an admin, and the viewer's user id. */
export interface ViewerSql {
  org: string;
  admin: string;
  user: string;
}

/** The fixed placeholders a single-viewer read binds: $1 = org id,
 *  $2 = caller is admin, $3 = caller user id. */
export const VIEWER_PARAMS: ViewerSql = {
  org: "$1",
  admin: "$2::boolean",
  user: "$3",
};

/** The viewer columns of a `users` alias. */
export function userViewer(alias: string): ViewerSql {
  return {
    org: `${alias}.org_id`,
    admin: `(${alias}.role = 'admin')`,
    user: `${alias}.id`,
  };
}

interface ItemTable {
  /** The item table, aliased as the caller's alias. */
  table: string;
  /** The grants table and its column naming the item. */
  grants: string;
  grantsColumn: string;
  /** The item table's owner column. */
  owner: string;
  /** The item table has a `is_personal` column. */
  personal: boolean;
}

const ITEMS: Record<AccessKind, ItemTable> = {
  agent: {
    table: "agents",
    grants: "agent_access",
    grantsColumn: "agent_id",
    owner: "owner_user_id",
    personal: true,
  },
  app: {
    table: "apps",
    grants: "app_access",
    grantsColumn: "app_id",
    owner: "owner_user_id",
    personal: false,
  },
};

/** A member's access to one item: `edit` manages it, `read` sees and uses it,
 *  null means it is not theirs to see. */
export type AccessLevelOf = AccessLevel | null;

/** The predicate every visibility-filtered read applies to `alias`. An admin
 *  reads every item of the org. A personal item reaches its owner and admins
 *  only. */
export function accessPredicate(
  kind: AccessKind,
  alias: string,
  viewer: ViewerSql = VIEWER_PARAMS,
): string {
  const item = ITEMS[kind];
  const reach = `(
    ${alias}.visibility = 'org'
    OR EXISTS (SELECT 1 FROM ${item.grants} g
      WHERE g.${item.grantsColumn} = ${alias}.id AND (
        g.user_id = ${viewer.user}
        OR (g.team_id IS NOT NULL AND EXISTS (
          SELECT 1 FROM team_members tm WHERE tm.team_id = g.team_id AND tm.user_id = ${viewer.user})))))`;
  const shared = item.personal
    ? `(${alias}.is_personal = false AND ${reach})`
    : reach;
  return `(${alias}.org_id = ${viewer.org} AND (
    ${alias}.${item.owner} = ${viewer.user}
    OR ${viewer.admin}
    OR ${shared}
  ))`;
}

/** The predicate for managing one item: its owner, an admin, or an `edit`
 *  entry for the viewer or one of their Teams. */
export function editPredicate(
  kind: AccessKind,
  alias: string,
  viewer: ViewerSql = VIEWER_PARAMS,
): string {
  const item = ITEMS[kind];
  return `(${alias}.${item.owner} = ${viewer.user} OR ${viewer.admin} OR EXISTS (
    SELECT 1 FROM ${item.grants} g
    WHERE g.${item.grantsColumn} = ${alias}.id AND g.level = 'edit' AND (
      g.user_id = ${viewer.user}
      OR (g.team_id IS NOT NULL AND EXISTS (
        SELECT 1 FROM team_members tm WHERE tm.team_id = g.team_id AND tm.user_id = ${viewer.user})))))`;
}

/** The level an entry gives its subject: `edit` wins over `read`. */
function strongest(levels: readonly AccessLevel[]): AccessLevel | null {
  if (levels.includes("edit")) return "edit";
  if (levels.includes("read")) return "read";
  return null;
}

export class AccessStore {
  constructor(private readonly pool: PlatformPool) {}

  /** The item's owner and org, or 404 when it does not exist. */
  private async item(
    orgId: string,
    kind: AccessKind,
    itemId: string,
  ): Promise<{ owner: string }> {
    const item = ITEMS[kind];
    const res = await this.pool.query(
      `SELECT ${item.owner} AS owner_user_id FROM ${item.table} WHERE org_id = $1 AND id = $2`,
      [orgId, itemId],
    );
    const row = res.rows[0];
    if (row === undefined) throw ApiError.notFound(`no such ${kind}`);
    return { owner: row.owner_user_id as string };
  }

  /** The caller's level on one item, without the visibility filter: the
   *  caller must already be able to see it. */
  async level(
    kind: AccessKind,
    itemId: string,
    user: UserRow,
  ): Promise<AccessLevelOf> {
    const item = ITEMS[kind];
    const res = await this.pool.query(
      `SELECT a.visibility, a.${item.owner} AS owner_user_id,
              COALESCE((SELECT array_agg(g.level) FROM ${item.grants} g
                WHERE g.${item.grantsColumn} = a.id AND (
                  g.user_id = $2
                  OR (g.team_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM team_members tm WHERE tm.team_id = g.team_id AND tm.user_id = $2)))), '{}') AS levels
         FROM ${item.table} a WHERE a.id = $1`,
      [itemId, user.id],
    );
    const row = res.rows[0];
    if (row === undefined) return null;
    if (user.role === "admin" || (row.owner_user_id as string) === user.id)
      return "edit";
    const granted = strongest((row.levels as AccessLevel[] | null) ?? []);
    if (granted !== null) return granted;
    return row.visibility === "org" ? "read" : null;
  }

  /** The item's entries, labelled: the org entry first, then teams by name,
   *  then Members by name. */
  async entries(
    orgId: string,
    kind: AccessKind,
    itemId: string,
  ): Promise<AccessEntry[]> {
    const item = ITEMS[kind];
    const meta = await this.pool.query(
      `SELECT visibility FROM ${item.table} WHERE org_id = $1 AND id = $2`,
      [orgId, itemId],
    );
    const row = meta.rows[0];
    if (row === undefined) throw ApiError.notFound(`no such ${kind}`);
    const grants = await this.pool.query(
      `SELECT g.user_id, g.team_id, g.level,
              COALESCE(NULLIF(u.display_name, ''), u.email) AS user_label,
              t.name AS team_label
         FROM ${item.grants} g
         LEFT JOIN users u ON u.id = g.user_id
         LEFT JOIN teams t ON t.id = g.team_id
        WHERE g.${item.grantsColumn} = $1
        ORDER BY t.name NULLS LAST, u.display_name NULLS LAST, u.email`,
      [itemId],
    );
    const out: AccessEntry[] = [];
    if (row.visibility === "org") {
      out.push({
        subject_kind: "org",
        subject_id: null,
        subject_label: "Everyone in the org",
        level: "read",
      });
    }
    for (const grant of grants.rows as Record<string, unknown>[]) {
      const teamId = grant.team_id as string | null;
      out.push({
        subject_kind: teamId === null ? "user" : "team",
        subject_id: (teamId ?? grant.user_id) as string,
        subject_label:
          ((teamId === null ? grant.user_label : grant.team_label) as
            string | null) ?? "",
        level: grant.level as AccessLevel,
      });
    }
    return out;
  }

  /** Replaces an item's entries. The org entry becomes the item's
   *  `visibility`; every other entry becomes a row. The caller has already
   *  been checked for manage. */
  async replace(
    orgId: string,
    kind: AccessKind,
    itemId: string,
    entries: readonly AccessInput[],
  ): Promise<void> {
    const item = ITEMS[kind];
    await this.item(orgId, kind, itemId);
    const orgShared = entries.some((entry) => entry.subject_kind === "org");
    const rows = entries.filter((entry) => entry.subject_kind !== "org");
    const userIds = rows
      .filter((r) => r.subject_kind === "user")
      .map((r) => r.subject_id as string);
    const teamIds = rows
      .filter((r) => r.subject_kind === "team")
      .map((r) => r.subject_id as string);
    if (
      new Set(userIds).size !== userIds.length ||
      new Set(teamIds).size !== teamIds.length
    ) {
      throw ApiError.badRequest("an entry appears twice");
    }
    if (userIds.length > 0) {
      const found = await this.pool.query(
        "SELECT id FROM users WHERE org_id = $1 AND id = ANY($2::uuid[])",
        [orgId, userIds],
      );
      if (found.rowCount !== userIds.length)
        throw ApiError.badRequest("unknown member");
    }
    if (teamIds.length > 0) {
      const found = await this.pool.query(
        "SELECT id FROM teams WHERE org_id = $1 AND id = ANY($2::uuid[])",
        [orgId, teamIds],
      );
      if (found.rowCount !== teamIds.length)
        throw ApiError.badRequest("unknown team");
    }
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE ${item.table} SET visibility = $3, updated_at = now() WHERE org_id = $1 AND id = $2`,
        [orgId, itemId, orgShared ? "org" : "private"],
      );
      await client.query(
        `DELETE FROM ${item.grants} WHERE ${item.grantsColumn} = $1`,
        [itemId],
      );
      for (const entry of rows) {
        await client.query(
          `INSERT INTO ${item.grants} (${item.grantsColumn}, user_id, team_id, level) VALUES ($1, $2, $3, $4)`,
          [
            itemId,
            entry.subject_kind === "user" ? entry.subject_id : null,
            entry.subject_kind === "team" ? entry.subject_id : null,
            entry.level,
          ],
        );
      }
    });
  }

  /** For each of `userIds`, the org's items they may see and their level on
   *  each, in one read. A user outside the org, or one who sees nothing,
   *  maps to an empty map. */
  async visibleIds(
    orgId: string,
    kind: AccessKind,
    userIds: readonly string[],
  ): Promise<Map<string, Map<string, AccessLevel>>> {
    const out = new Map<string, Map<string, AccessLevel>>(
      userIds.map((userId) => [userId, new Map()]),
    );
    if (userIds.length === 0) return out;
    const item = ITEMS[kind];
    const res = await this.pool.query<{
      user_id: string;
      item_id: string;
      level: AccessLevel;
    }>(
      `SELECT u.id AS user_id, a.id AS item_id,
              CASE WHEN ${editPredicate(kind, "a", userViewer("u"))} THEN 'edit' ELSE 'read' END AS level
         FROM users u JOIN ${item.table} a ON a.org_id = u.org_id
        WHERE u.org_id = $1 AND u.id = ANY($2::uuid[])
          AND ${accessPredicate(kind, "a", userViewer("u"))}`,
      [orgId, userIds],
    );
    for (const row of res.rows)
      out.get(row.user_id)?.set(row.item_id, row.level);
    return out;
  }

  /** The org's teams, by name: what an access picker offers. */
  async teams(orgId: string): Promise<AccessTeam[]> {
    const res = await this.pool.query(
      "SELECT id, name FROM teams WHERE org_id = $1 ORDER BY name",
      [orgId],
    );
    return (res.rows as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      label: row.name as string,
    }));
  }

  /** The org's people, by display name: what an access picker offers. */
  async people(orgId: string): Promise<AccessPerson[]> {
    const res = await this.pool.query(
      `SELECT id, COALESCE(NULLIF(display_name, ''), email) AS label, avatar_url
         FROM users WHERE org_id = $1 ORDER BY label`,
      [orgId],
    );
    return (res.rows as Record<string, unknown>[]).map((row) => ({
      id: row.id as string,
      label: row.label as string,
      avatar_url: (row.avatar_url as string | null) ?? null,
    }));
  }
}
