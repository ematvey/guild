// The agent inbox: notices an agent leaves for a user, newest first, with
// their read marker.

import { ApiError } from "../../platform/errors.js";
import type { PlatformPool } from "../../platform/db.js";
import { jsonbText } from "../../platform/domain/text.js";
import { uuidv7 } from "../../platform/time.js";
import type { AgentNotice } from "../types.js";
import { NOTICE_COLUMNS, toNotice } from "./rows.js";

export interface CreateNoticeInput {
  org_id: string;
  agent_id?: string | null;
  user_id?: string | null;
  kind: string;
  payload?: Record<string, unknown>;
}

export class AgentNoticeStore {
  constructor(private readonly pool: PlatformPool) {}

  async listNotices(userId: string, orgId: string): Promise<AgentNotice[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${NOTICE_COLUMNS} FROM agent_notices n
       WHERE n.org_id = $1 AND n.user_id = $2
       ORDER BY n.created_at DESC LIMIT 100`,
      [orgId, userId],
    );
    return res.rows.map(toNotice);
  }

  async markNoticeRead(userId: string, noticeId: string): Promise<AgentNotice> {
    return this.setRead(userId, noticeId, "COALESCE(read_at, now())");
  }

  async markNoticeUnread(userId: string, noticeId: string): Promise<AgentNotice> {
    return this.setRead(userId, noticeId, "NULL");
  }

  private async setRead(userId: string, noticeId: string, readAt: string): Promise<AgentNotice> {
    const res = await this.pool.query<Record<string, unknown>>(
      `WITH n AS (
         UPDATE agent_notices SET read_at = ${readAt}
         WHERE id = $1 AND user_id = $2 RETURNING *)
       SELECT ${NOTICE_COLUMNS} FROM n`,
      [noticeId, userId],
    );
    const row = res.rows[0];
    if (row === undefined) throw ApiError.notFound("no such notice");
    return toNotice(row);
  }

  async createNotice(input: CreateNoticeInput): Promise<AgentNotice> {
    const res = await this.pool.query<Record<string, unknown>>(
      `WITH n AS (
         INSERT INTO agent_notices (id, org_id, agent_id, user_id, kind, payload)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb)
         RETURNING *)
       SELECT ${NOTICE_COLUMNS} FROM n`,
      [
        uuidv7(),
        input.org_id,
        input.agent_id ?? null,
        input.user_id ?? null,
        input.kind,
        jsonbText(input.payload ?? {}),
      ],
    );
    return toNotice(res.rows[0]!);
  }
}
