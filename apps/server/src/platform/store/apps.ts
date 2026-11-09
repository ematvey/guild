// Apps: one row per App, one row per published version (migration 0116).
// The newest version is the one that runs. Reads are org-scoped; who may see
// an App is its owner, or every member when its visibility is `org`.

import { createHash } from "node:crypto";
import { ApiError } from "../errors.js";
import { pgTimestampToRfc3339, utcText, uuidv7 } from "../time.js";
import { withTransaction, type PlatformPool } from "../db.js";
import type { AppFunction } from "../domain/app-functions.js";

export type AppVisibility = "private" | "org";

/** An App as lists and the frame carry it: everything but the page. */
export interface AppRow {
  id: string;
  org_id: string;
  owner_user_id: string;
  owner_label: string;
  agent_id: string | null;
  agent_name: string | null;
  chat_id: string | null;
  name: string;
  description: string;
  visibility: AppVisibility;
  version: number;
  functions: AppFunction[];
  created_at: string;
  updated_at: string;
}

/** The input of one publish: a new App, or a new version of `app_id`. */
export interface AppPublish {
  orgId: string;
  ownerUserId: string;
  agentId: string | null;
  chatId: string | null;
  appId?: string;
  name: string;
  description: string;
  html: string;
  functions: AppFunction[];
}

export const MAX_APP_HTML_BYTES = 2 * 1024 * 1024;
export const MAX_APP_NAME = 80;
export const MAX_APP_DESCRIPTION = 500;

const SELECT =
  "SELECT a.id, a.org_id, a.owner_user_id, COALESCE(NULLIF(u.display_name, ''), u.email) AS owner_label, " +
  "a.agent_id, ag.name AS agent_name, a.chat_id, a.name, a.description, a.visibility, a.version, " +
  "v.functions, " +
  utcText("a.created_at") +
  " AS created_at, " +
  utcText("a.updated_at") +
  " AS updated_at " +
  "FROM apps a JOIN users u ON u.id = a.owner_user_id " +
  "LEFT JOIN agents ag ON ag.id = a.agent_id " +
  "JOIN app_versions v ON v.app_id = a.id AND v.version = a.version ";

function appRow(r: Record<string, unknown>): AppRow {
  return {
    id: r.id as string,
    org_id: r.org_id as string,
    owner_user_id: r.owner_user_id as string,
    owner_label: (r.owner_label as string | null) ?? "",
    agent_id: (r.agent_id as string | null) ?? null,
    agent_name: (r.agent_name as string | null) ?? null,
    chat_id: (r.chat_id as string | null) ?? null,
    name: r.name as string,
    description: r.description as string,
    visibility: r.visibility as AppVisibility,
    version: Number(r.version),
    functions: (r.functions as AppFunction[] | null) ?? [],
    created_at: pgTimestampToRfc3339(r.created_at as string),
    updated_at: pgTimestampToRfc3339(r.updated_at as string),
  };
}

/** Whether a member sees an App: their own, or one shared with the org. */
export function appVisibleTo(app: Pick<AppRow, "owner_user_id" | "visibility">, userId: string): boolean {
  return app.owner_user_id === userId || app.visibility === "org";
}

export class AppStore {
  constructor(readonly pool: PlatformPool) {}

  /** Every App of the org, newest change first. */
  async listForOrg(orgId: string): Promise<AppRow[]> {
    const res = await this.pool.query(`${SELECT} WHERE a.org_id = $1 ORDER BY a.updated_at DESC, a.id`, [orgId]);
    return res.rows.map(appRow);
  }

  /** The Apps each member sees, keyed by user id; the org rows load once. */
  async listVisible(orgId: string, userIds: readonly string[]): Promise<Map<string, AppRow[]>> {
    const rows = await this.listForOrg(orgId);
    return new Map(userIds.map((userId) => [userId, rows.filter((row) => appVisibleTo(row, userId))]));
  }

  /** One App of the org; 404 when it is missing or the member cannot see it. */
  async getVisible(orgId: string, id: string, userId: string): Promise<AppRow> {
    const res = await this.pool.query(`${SELECT} WHERE a.org_id = $1 AND a.id = $2`, [orgId, id]);
    const row = res.rows[0];
    if (row === undefined) throw ApiError.notFound("no such app");
    const app = appRow(row);
    if (!appVisibleTo(app, userId)) throw ApiError.notFound("no such app");
    return app;
  }

  /** The page of one version. */
  async page(appId: string, version: number): Promise<{ html: string; sha256: string }> {
    const res = await this.pool.query("SELECT html, sha256 FROM app_versions WHERE app_id = $1 AND version = $2", [
      appId,
      version,
    ]);
    const row = res.rows[0];
    if (row === undefined) throw ApiError.notFound("no such app version");
    return { html: row.html as string, sha256: row.sha256 as string };
  }

  /** Creates an App, or adds a version to one the publisher owns. The new
   *  version is the one that runs. */
  async publish(input: AppPublish): Promise<AppRow> {
    const sha256 = createHash("sha256").update(input.html).digest("hex");
    const id = await withTransaction(this.pool, async (client) => {
      if (input.appId === undefined) {
        const appId = uuidv7();
        await client.query(
          "INSERT INTO apps (id, org_id, owner_user_id, agent_id, chat_id, name, description) " +
            "VALUES ($1, $2, $3, $4, $5, $6, $7)",
          [appId, input.orgId, input.ownerUserId, input.agentId, input.chatId, input.name, input.description],
        );
        await client.query(
          "INSERT INTO app_versions (app_id, version, html, functions, sha256, created_by) VALUES ($1, 1, $2, $3, $4, $5)",
          [appId, input.html, JSON.stringify(input.functions), sha256, input.ownerUserId],
        );
        return appId;
      }
      const res = await client.query(
        "SELECT owner_user_id, version FROM apps WHERE org_id = $1 AND id = $2 FOR UPDATE",
        [input.orgId, input.appId],
      );
      const row = res.rows[0];
      if (row === undefined) throw ApiError.notFound("no such app");
      if (row.owner_user_id !== input.ownerUserId) throw ApiError.forbidden("only the app's owner can publish it");
      const version = Number(row.version) + 1;
      await client.query(
        "INSERT INTO app_versions (app_id, version, html, functions, sha256, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
        [input.appId, version, input.html, JSON.stringify(input.functions), sha256, input.ownerUserId],
      );
      await client.query(
        "UPDATE apps SET version = $2, name = $3, description = $4, agent_id = COALESCE($5, agent_id), " +
          "chat_id = COALESCE($6, chat_id), updated_at = now() WHERE id = $1",
        [input.appId, version, input.name, input.description, input.agentId, input.chatId],
      );
      return input.appId;
    });
    return this.getVisible(input.orgId, id, input.ownerUserId);
  }

  /** The functions one viewer granted for one App version. */
  async grants(appId: string, userId: string, version: number): Promise<Set<string>> {
    const res = await this.pool.query(
      "SELECT function FROM app_grants WHERE app_id = $1 AND user_id = $2 AND version = $3",
      [appId, userId, version],
    );
    return new Set(res.rows.map((row) => row.function as string));
  }

  /** Records a viewer's standing yes to one function of one App version. */
  async grant(appId: string, userId: string, version: number, fn: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO app_grants (app_id, user_id, version, function) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING",
      [appId, userId, version, fn],
    );
  }

  /** Drops every grant one viewer gave one App. */
  async clearGrants(appId: string, userId: string): Promise<void> {
    await this.pool.query("DELETE FROM app_grants WHERE app_id = $1 AND user_id = $2", [appId, userId]);
  }

  /** Changes who sees an App; owner only. */
  async setVisibility(orgId: string, id: string, userId: string, visibility: AppVisibility): Promise<AppRow> {
    const res = await this.pool.query(
      "UPDATE apps SET visibility = $4, updated_at = now() WHERE org_id = $1 AND id = $2 AND owner_user_id = $3",
      [orgId, id, userId, visibility],
    );
    if (res.rowCount === 0) throw ApiError.notFound("no such app");
    return this.getVisible(orgId, id, userId);
  }

  /** Deletes an App and its versions: its owner, or an admin for an App
   *  shared with the org. */
  async delete(orgId: string, id: string, user: { id: string; role: string }): Promise<void> {
    const res = await this.pool.query(
      "DELETE FROM apps WHERE org_id = $1 AND id = $2 AND (owner_user_id = $3 OR ($4 AND visibility = 'org'))",
      [orgId, id, user.id, user.role === "admin"],
    );
    if (res.rowCount === 0) throw ApiError.notFound("no such app");
  }
}
