// Server-side agent sessions store: one row per workspace execution-backend
// session; the run state
// lives in the durable conversation, the row stays metadata.

import { ApiError } from "../errors.js";
import type { PlatformPool } from "../db.js";
import { uuidv7, pgTimestampToRfc3339 } from "../time.js";

export interface AgentSessionRow {
  id: string;
  org_id: string;
  user_id: string;
  chat_id: string;
  workspace_name: string;
  created_at: string;
}

/** Only safe filesystem names for workspace dirs. */
export function validWorkspaceName(name: string): boolean {
  return name.length > 0 && name.length <= 64 && /^[a-zA-Z0-9_-]+$/.test(name);
}

/** Minimal transactional executor (a pg pool client) — enough for the
 *  sibling-store inserts the session-create transaction composes. */
export interface TxExecutor {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  release: () => void;
}

const ROW_COLUMNS = "id, org_id, user_id, chat_id, workspace_name, to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS created_at";

export class AgentSessionStore {
  constructor(private readonly pool: PlatformPool) {}

  /** Inserts the session row on a caller-supplied transaction (the create
   *  handler runs it uncommitted until the workspace is ready). */
  async createOn(
    client: TxExecutor,
    orgId: string,
    userId: string,
    chatId: string,
    workspaceName: string,
  ): Promise<AgentSessionRow> {
    if (!validWorkspaceName(workspaceName)) {
      throw ApiError.badRequest("workspace_name must be 1-64 chars of [a-zA-Z0-9-_]");
    }
    const id = uuidv7();
    try {
      const res = (await client.query(
        `INSERT INTO agent_sessions (id, org_id, user_id, chat_id, workspace_name)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${ROW_COLUMNS}`,
        [id, orgId, userId, chatId, workspaceName],
      )) as { rows: Record<string, string>[] };
      const r = res.rows[0]!;
      return { ...(r as unknown as AgentSessionRow), created_at: pgTimestampToRfc3339(r.created_at) };
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw ApiError.conflict("workspace_taken", "a session with this workspace name already exists");
      }
      throw error;
    }
  }

  async list(orgId: string, userId: string): Promise<AgentSessionRow[]> {
    const res = await this.pool.query<Record<string, string>>(
      `SELECT ${ROW_COLUMNS} FROM agent_sessions WHERE org_id = $1 AND user_id = $2 ORDER BY created_at DESC`,
      [orgId, userId],
    );
    return res.rows.map((r) => ({ ...(r as unknown as AgentSessionRow), created_at: pgTimestampToRfc3339(r.created_at) }));
  }

  /** Creates a session end to end in one transaction: the chat insert
   *  (injected capability — the chat store stays independent of this one),
   *  the session insert, and the workspace preparation (injected callback)
   *  run uncommitted until the orphan reclaim and dir create succeeded.
   *  A failing rollback is swallowed; the failure itself propagates. */
  async createWithChat(
    orgId: string,
    userId: string,
    workspaceName: string,
    createChat: (client: TxExecutor) => Promise<{ id: string }>,
    prepareWorkspace: () => Promise<void>,
  ): Promise<AgentSessionRow> {
    const client = (await this.pool.connect()) as TxExecutor;
    try {
      await client.query("BEGIN");
      const chat = await createChat(client);
      const session = await this.createOn(client, orgId, userId, chat.id, workspaceName);
      await prepareWorkspace();
      await client.query("COMMIT");
      return session;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Fetches one session the caller owns (admins bypass) — an org-scoped
   *  lookup alone would let a member run turns in another member's session
   *  and spend the org's money there. */
  async get(orgId: string, id: string, caller: { id: string; role: string }): Promise<AgentSessionRow> {
    const isAdmin = caller.role === "admin";
    const res = await this.pool.query<Record<string, string>>(
      `SELECT ${ROW_COLUMNS} FROM agent_sessions WHERE org_id = $1 AND id = $2 AND (user_id = $3 OR $4)`,
      [orgId, id, caller.id, isAdmin],
    );
    const r = res.rows[0];
    if (!r) throw ApiError.notFound("no such session");
    return { ...(r as unknown as AgentSessionRow), created_at: pgTimestampToRfc3339(r.created_at) };
  }

  /** The workspace name bound to a chat, when the chat is an agent session
   *  (the harness env factory reads this per tool call). */
  async workspaceForChat(orgId: string, chatId: string): Promise<string | null> {
    const res = await this.pool.query<{ workspace_name: string }>(
      "SELECT workspace_name FROM agent_sessions WHERE org_id = $1 AND chat_id = $2",
      [orgId, chatId],
    );
    return res.rows[0]?.workspace_name ?? null;
  }
}
