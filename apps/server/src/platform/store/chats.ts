// Chat-ownership gate needed by the attachment routes (crates/server/src/
// store/chats.rs get_chat): the full chats store arrives with the chats
// cutover; only the owner predicate is in scope here.

import { ApiError } from "../http/error.js";
import type { PlatformPool } from "../db.js";
import type { UserRow } from "./identity.js";
import { pgTimestampToRfc3339 } from "../time.js";

export interface ChatRow {
  id: string;
  org_id: string;
  user_id: string;
  title: string | null;
  created_at: string;
}

/** Fetches one chat the caller owns. Admins may access any chat in the
 *  org; everyone else only their own — org scoping alone would let a
 *  member read another member's thread, forge its events, rebind its
 *  machine, or spend the org's tokens through it. */
export async function getChatOwned(
  pool: PlatformPool,
  orgId: string,
  chatId: string,
  caller: UserRow,
): Promise<ChatRow> {
  const isAdmin = caller.role === "admin";
  const res = await pool.query<{
    id: string;
    org_id: string;
    user_id: string;
    title: string | null;
    created_at: string;
  }>(
    `SELECT id, org_id, user_id, title,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at
     FROM chats
     WHERE org_id = $1 AND id = $2 AND (user_id = $3 OR $4)`,
    [orgId, chatId, caller.id, isAdmin],
  );
  const row = res.rows[0];
  if (!row) throw ApiError.notFound("no such chat");
  return { ...row, created_at: pgTimestampToRfc3339(row.created_at) };
}
