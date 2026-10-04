// Chat attachments (spec §4.3/§5, crates/server/src/store/attachments.rs):
// metadata in Postgres, bytes in object storage under the object key.

import { ApiError } from "../errors.js";
import type { PlatformPool } from "../db.js";
import { pgTimestampToRfc3339 } from "../time.js";

export interface AttachmentRow {
  id: string;
  org_id: string;
  chat_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
}

// created_at is always selected as the to_char text alias (chrono-shaped
// RFC 3339 formatting happens in SQL), never as the plain column.
const ATTACHMENT_COLUMNS =
  "id, org_id, chat_id, filename, content_type, size_bytes";

interface AttachmentDbRow {
  id: string;
  org_id: string;
  chat_id: string;
  filename: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
}

function toRow(db: AttachmentDbRow): AttachmentRow {
  return { ...db, created_at: pgTimestampToRfc3339(db.created_at) };
}

/** Object-storage key for an attachment (shared by the HTTP upload/download
 *  handlers and the turn-injection path in the worker). */
export function attachmentObjectKey(orgId: string, id: string, filename: string): string {
  return `attachments/${orgId}/${id}/${filename}`;
}

/** Only safe path segments for object keys. */
export function safeFilename(name: string): string | null {
  let cleaned = "";
  for (const c of name) {
    cleaned += /[a-zA-Z0-9.\-_]/.test(c) ? c : "_";
  }
  if (cleaned === "" || cleaned.length > 128 || cleaned.startsWith(".")) return null;
  return cleaned;
}

export class AttachmentStore {
  constructor(readonly pool: PlatformPool) {}

  async create(
    id: string,
    orgId: string,
    chatId: string,
    filename: string,
    contentType: string,
    sizeBytes: number,
    objectKey: string,
  ): Promise<AttachmentRow> {
    const res = await this.pool.query<AttachmentDbRow>(
      `INSERT INTO attachments (id, org_id, chat_id, filename, content_type, size_bytes, object_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${ATTACHMENT_COLUMNS},
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at`,
      [id, orgId, chatId, filename, contentType, sizeBytes, objectKey],
    );
    return toRow(res.rows[0]!);
  }

  async list(orgId: string, chatId: string): Promise<AttachmentRow[]> {
    const res = await this.pool.query<AttachmentDbRow>(
      `SELECT ${ATTACHMENT_COLUMNS},
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM attachments WHERE org_id = $1 AND chat_id = $2 ORDER BY attachments.created_at`,
      [orgId, chatId],
    );
    return res.rows.map(toRow);
  }

  async get(orgId: string, id: string): Promise<AttachmentRow> {
    const res = await this.pool.query<AttachmentDbRow>(
      `SELECT ${ATTACHMENT_COLUMNS},
         to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
       FROM attachments WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    const row = res.rows[0];
    if (!row) throw ApiError.notFound("no such attachment");
    return toRow(row);
  }
}
