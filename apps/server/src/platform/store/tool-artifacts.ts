// Tool artifacts store:
// spilled oversized tool results — metadata in Postgres, bytes in object
// storage, org-scoped reads.

import { ApiError } from "../errors.js";
import type { PlatformPool } from "../db.js";
import { utcText, uuidv5 } from "../time.js";
import { pgTimestampToRfc3339 } from "../time.js";

export interface ToolArtifactRow {
  id: string;
  org_id: string;
  chat_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  tool_name: string;
  call_id: string;
  created_at: string;
}

interface ToolArtifactDbRow {
  id: string;
  org_id: string;
  chat_id: string;
  filename: string;
  content_type: string;
  size_bytes: string | number;
  tool_name: string;
  call_id: string;
  created_at: string;
}

function toRow(r: ToolArtifactDbRow): ToolArtifactRow {
  return { ...r, size_bytes: Number(r.size_bytes), created_at: pgTimestampToRfc3339(r.created_at) };
}

/** Object-storage key for a tool artifact (mirrors the attachments layout). */
export function toolArtifactObjectKey(orgId: string, id: string, filename: string): string {
  return `tool_artifacts/${orgId}/${id}/${filename}`;
}

const NAMESPACE_DNS = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** Deterministic artifact id: uuid v5 over the chat id and the tool call id.
 *  The same tool call always resolves to the same artifact row — the core of
 *  replay idempotence (chats/spill.ts). */
export function artifactUuid(chatId: string, callId: string): string {
  return uuidv5(NAMESPACE_DNS, `guild-tool-artifact:${chatId}:${callId}`);
}

const ROW_COLUMNS =
  "id, org_id, chat_id, filename, content_type, size_bytes, tool_name, call_id, " +
  utcText("created_at") +
  " AS created_at";

export class ToolArtifactStore {
  constructor(private readonly pool: PlatformPool) {}

  /** Inserts one artifact row; a replay of the same tool call is a no-op
   *  and returns the existing row (create-or-reuse). */
  async create(
    id: string,
    orgId: string,
    chatId: string,
    filename: string,
    contentType: string,
    sizeBytes: number,
    objectKey: string,
    toolName: string,
    callId: string,
  ): Promise<ToolArtifactRow> {
    await this.pool.query(
      `INSERT INTO tool_artifacts (id, org_id, chat_id, filename, content_type, size_bytes, object_key, tool_name, call_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT DO NOTHING`,
      [id, orgId, chatId, filename, contentType, sizeBytes, objectKey, toolName, callId],
    );
    return this.get(orgId, id);
  }

  async get(orgId: string, id: string): Promise<ToolArtifactRow> {
    const res = await this.pool.query<ToolArtifactDbRow>(
      `SELECT ${ROW_COLUMNS} FROM tool_artifacts WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    const row = res.rows[0];
    if (!row) throw ApiError.notFound("no such tool artifact");
    return toRow(row);
  }

  async listForChat(orgId: string, chatId: string): Promise<ToolArtifactRow[]> {
    const res = await this.pool.query<ToolArtifactDbRow>(
      `SELECT ${ROW_COLUMNS} FROM tool_artifacts WHERE org_id = $1 AND chat_id = $2 ORDER BY created_at, id`,
      [orgId, chatId],
    );
    return res.rows.map(toRow);
  }
}
