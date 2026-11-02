// User-owned MCP servers: CRUD rows per (org, user) and the AES-256-GCM
// encrypted header object. Header values never leave the store in
// plaintext except through resolveHeaders; listings carry masked previews
// (e.g. "Bearer ••••") and header names only — the same discipline the
// integration secret store applies.

import { randomUUID } from "node:crypto";
import { decryptSecret, encryptSecret, maskSecretLen } from "../crypto.js";
import { pgTimestampToRfc3339, utcText } from "../time.js";
import type { PlatformPool } from "../db.js";

export interface UserMcpRow {
  id: string;
  org_id: string;
  user_id: string;
  name: string;
  url: string;
  headers_enc: Buffer | null;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** The listing/detail shape the API returns: header names with masked
 *  previews, never values. */
export interface UserMcpHeaderPreview {
  name: string;
  masked: string;
}

/** Masked preview of one header value: a scheme-like first word stays
 *  visible ("Bearer ••••"), everything else is bullets only. */
export function maskHeaderValue(value: string): string {
  const space = value.indexOf(" ");
  if (space > 0 && space <= 16) {
    return `${value.slice(0, space)} ${maskSecretLen([...value].length - space - 1)}`;
  }
  return maskSecretLen([...value].length);
}

export class UserMcpStore {
  constructor(readonly pool: PlatformPool) {}

  async list(orgId: string, userId: string): Promise<UserMcpRow[]> {
    const res = await this.pool.query(
      "SELECT id, org_id, user_id, name, url, headers_enc, enabled, " +
        utcText("created_at") +
        " AS created_at, " +
        utcText("updated_at") +
        " AS updated_at " +
        "FROM user_mcp_servers WHERE org_id = $1 AND user_id = $2 ORDER BY created_at",
      [orgId, userId],
    );
    return res.rows.map((r: Record<string, unknown>) => rowOf(r));
  }

  /** Enabled rows only, in name order — the runtime's per-turn input. */
  async listEnabled(orgId: string, userId: string): Promise<UserMcpRow[]> {
    const res = await this.pool.query(
      "SELECT id, org_id, user_id, name, url, headers_enc, enabled, " +
        utcText("created_at") +
        " AS created_at, " +
        utcText("updated_at") +
        " AS updated_at " +
        "FROM user_mcp_servers WHERE org_id = $1 AND user_id = $2 AND enabled ORDER BY name",
      [orgId, userId],
    );
    return res.rows.map((r: Record<string, unknown>) => rowOf(r));
  }

  async get(orgId: string, userId: string, id: string): Promise<UserMcpRow | null> {
    const res = await this.pool.query(
      "SELECT id, org_id, user_id, name, url, headers_enc, enabled, " +
        utcText("created_at") +
        " AS created_at, " +
        utcText("updated_at") +
        " AS updated_at " +
        "FROM user_mcp_servers WHERE org_id = $1 AND user_id = $2 AND id = $3",
      [orgId, userId, id],
    );
    return res.rows[0] === undefined ? null : rowOf(res.rows[0]);
  }

  async create(
    orgId: string,
    userId: string,
    name: string,
    url: string,
    headers: Record<string, string> | undefined,
    enabled: boolean,
    masterKey: Buffer,
  ): Promise<UserMcpRow> {
    const res = await this.pool.query(
      "INSERT INTO user_mcp_servers (id, org_id, user_id, name, url, headers_enc, enabled) " +
        "VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
      [randomUUID(), orgId, userId, name, url, encodeHeaders(headers, masterKey), enabled],
    );
    const created = await this.get(orgId, userId, res.rows[0]!.id as string);
    if (created === null) throw new Error("user_mcp_servers insert vanished");
    return created;
  }

  /** Updates any subset of name/url/headers/enabled; absent fields stay. */
  async update(
    orgId: string,
    userId: string,
    id: string,
    patch: {
      name?: string;
      url?: string;
      headers?: Record<string, string>;
      enabled?: boolean;
    },
    masterKey: Buffer,
  ): Promise<UserMcpRow | null> {
    const existing = await this.get(orgId, userId, id);
    if (existing === null) return null;
    const name = patch.name ?? existing.name;
    const url = patch.url ?? existing.url;
    const headersEnc = patch.headers !== undefined ? encodeHeaders(patch.headers, masterKey) : existing.headers_enc;
    const enabled = patch.enabled ?? existing.enabled;
    await this.pool.query(
      "UPDATE user_mcp_servers SET name = $4, url = $5, headers_enc = $6, enabled = $7, updated_at = now() " +
        "WHERE org_id = $1 AND user_id = $2 AND id = $3",
      [orgId, userId, id, name, url, headersEnc, enabled],
    );
    return this.get(orgId, userId, id);
  }

  async delete(orgId: string, userId: string, id: string): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM user_mcp_servers WHERE org_id = $1 AND user_id = $2 AND id = $3", [
      orgId,
      userId,
      id,
    ]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Decrypts the stored header object (the probe path and the runtime's
   *  call-time re-resolution are the only readers). */
  resolveHeaders(enc: Buffer | null, masterKey: Buffer): Record<string, string> {
    if (enc === null) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(decryptSecret(masterKey, enc.toString("utf8")));
    } catch {
      return {};
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, string> = {};
    for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === "string") out[name] = value;
    }
    return out;
  }

  /** Masked previews of the stored headers (listings; values never leave). */
  previews(enc: Buffer | null, masterKey: Buffer): UserMcpHeaderPreview[] {
    if (enc === null) return [];
    return Object.entries(this.resolveHeaders(enc, masterKey)).map(([name, value]) => ({
      name,
      masked: maskHeaderValue(value),
    }));
  }
}

function encodeHeaders(headers: Record<string, string> | undefined, masterKey: Buffer): Buffer | null {
  if (headers === undefined || Object.keys(headers).length === 0) return null;
  return Buffer.from(encryptSecret(masterKey, JSON.stringify(headers)), "utf8");
}

function rowOf(r: Record<string, unknown>): UserMcpRow {
  return {
    id: r.id as string,
    org_id: r.org_id as string,
    user_id: r.user_id as string,
    name: r.name as string,
    url: r.url as string,
    headers_enc: r.headers_enc === null || r.headers_enc === undefined ? null : (r.headers_enc as Buffer),
    enabled: r.enabled === true,
    created_at: pgTimestampToRfc3339(r.created_at as string),
    updated_at: pgTimestampToRfc3339(r.updated_at as string),
  };
}
