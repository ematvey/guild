// Chat attachments:
// metadata in Postgres, bytes in object storage under the object key.

import { ApiError } from "../errors.js";
import type { PlatformPool } from "../db.js";
import { pgTimestampToRfc3339, utcText } from "../time.js";

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

  /** Inserts a user upload: the author is known now, the event id stays null
   *  until a message references the attachment. */
  async create(
    id: string,
    orgId: string,
    chatId: string,
    authorId: string,
    filename: string,
    contentType: string,
    sizeBytes: number,
    objectKey: string,
  ): Promise<AttachmentRow> {
    const res = await this.pool.query<AttachmentDbRow>(
      `INSERT INTO attachments
         (id, org_id, chat_id, filename, content_type, size_bytes, object_key,
          author_kind, author_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'user', $8)
       RETURNING ${ATTACHMENT_COLUMNS},
         ${utcText("created_at")} AS created_at`,
      [id, orgId, chatId, filename, contentType, sizeBytes, objectKey, authorId],
    );
    return toRow(res.rows[0]!);
  }

  /** Inserts an agent-authored attachment bound to the running turn: the
   *  event id stays null until the turn ends and the lifecycle publishes it. */
  async createAgentFile(input: {
    id: string;
    orgId: string;
    chatId: string;
    filename: string;
    contentType: string;
    sizeBytes: number;
    objectKey: string;
    authorId: string;
    sourcePath: string;
  }): Promise<AttachmentRow> {
    const res = await this.pool.query<AttachmentDbRow>(
      `INSERT INTO attachments
         (id, org_id, chat_id, filename, content_type, size_bytes, object_key,
          author_kind, author_id, source_path)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'agent', $8, $9)
       RETURNING ${ATTACHMENT_COLUMNS},
         ${utcText("created_at")} AS created_at`,
      [
        input.id,
        input.orgId,
        input.chatId,
        input.filename,
        input.contentType,
        input.sizeBytes,
        input.objectKey,
        input.authorId,
        input.sourcePath,
      ],
    );
    return toRow(res.rows[0]!);
  }

  /** The chat's agent-authored attachments that no assistant event carries
   *  yet, oldest first. The transcript projection stamps them onto the
   *  turn's terminal assistant message. */
  async pendingAgentFiles(chatId: string): Promise<AttachmentRow[]> {
    const res = await this.pool.query<AttachmentDbRow>(
      `SELECT ${ATTACHMENT_COLUMNS},
         ${utcText("created_at")} AS created_at
       FROM attachments
       WHERE chat_id = $1 AND author_kind = 'agent' AND event_id IS NULL
       ORDER BY created_at ASC, id ASC`,
      [chatId],
    );
    return res.rows.map(toRow);
  }

  /** Binds every unpublished agent attachment of a chat to its assistant
   *  event. Called once when the run reaches a terminal assistant event. */
  async publishAgentAttachments(chatId: string, eventId: string): Promise<void> {
    await this.pool.query(
      `UPDATE attachments SET event_id = $2
       WHERE chat_id = $1 AND author_kind = 'agent' AND event_id IS NULL`,
      [chatId, eventId],
    );
  }

  async byIds(orgId: string, ids: readonly string[]): Promise<AttachmentRow[]> {
    if (ids.length === 0) return [];
    const res = await this.pool.query<AttachmentDbRow>(
      `SELECT ${ATTACHMENT_COLUMNS},
         ${utcText("created_at")} AS created_at
       FROM attachments WHERE org_id = $1 AND id = ANY($2::uuid[])`,
      [orgId, ids],
    );
    return res.rows.map(toRow);
  }

  async list(orgId: string, chatId: string): Promise<AttachmentRow[]> {
    const res = await this.pool.query<AttachmentDbRow>(
      `SELECT ${ATTACHMENT_COLUMNS},
         ${utcText("created_at")} AS created_at
       FROM attachments WHERE org_id = $1 AND chat_id = $2 ORDER BY attachments.created_at`,
      [orgId, chatId],
    );
    return res.rows.map(toRow);
  }

  async get(orgId: string, id: string): Promise<AttachmentRow> {
    const res = await this.pool.query<AttachmentDbRow>(
      `SELECT ${ATTACHMENT_COLUMNS},
         ${utcText("created_at")} AS created_at
       FROM attachments WHERE org_id = $1 AND id = $2`,
      [orgId, id],
    );
    const row = res.rows[0];
    if (!row) throw ApiError.notFound("no such attachment");
    return toRow(row);
  }
}
