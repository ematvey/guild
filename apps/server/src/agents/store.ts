// AgentStore: agents, their thread index, runs, activity and inbox notices.
// Transcripts live in the existing chat journal; every agent thread owns one
// chats row (agent_threads.chat_id). Visibility and grant roles are resolved
// here so routes and the runtime share one authorization path.

import { ApiError } from "../platform/errors.js";
import type { PlatformPool } from "../platform/db.js";
import { pgTimestampToRfc3339, uuidv7 } from "../platform/time.js";
import { ChatStore } from "../platform/store/chats.js";
import type { UserRow } from "../platform/store/identity.js";
import type {
  Agent,
  AgentAccess,
  AgentActivityEntry,
  AgentArtifactStatus,
  AgentDelegationArtifact,
  AgentNotice,
  AgentRole,
  AgentRoutine,
  AgentRoutineOccurrence,
  AgentRun,
  AgentRunStatus,
  AgentRunStep,
  AgentStatus,
  AgentThread,
  AgentThreadKind,
  AgentToolName,
  AgentToolsMode,
  AgentTrigger,
  AgentVisibility,
} from "./types.js";
import { DEFAULT_AGENT_TOOLS } from "./types.js";
import {
  createOccurrence,
  createRoutine,
  deleteRoutine,
  getRoutine,
  listOccurrences,
  listRoutines,
  updateRoutine,
  type CreateRoutineInput,
  type UpdateRoutineInput,
} from "./routines.js";
import { insertChunks, search, type AgentChunkInput, type AgentSearchHit } from "./search.js";
import { agentWorkspaceDir, seedAgentWorkspace } from "./workspace-config.js";
import type { TraceStore } from "../platform/trace.js";

const DEFAULT_GRACE_DAYS = 30;

export interface CreateAgentInput {
  tools_mode?: AgentToolsMode;
  name: string;
  description?: string;
  model: string;
  tools?: AgentToolName[];
  visibility?: AgentVisibility;
  resources?: Record<string, unknown>;
  team_ids?: string[];
}

export interface UpdateAgentInput {
  tools_mode?: AgentToolsMode;
  name?: string;
  description?: string;
  model?: string;
  tools?: AgentToolName[];
  visibility?: AgentVisibility;
  resources?: Record<string, unknown>;
  team_ids?: string[];
}

export interface RunFilters {
  status?: AgentRunStatus;
  trigger?: AgentTrigger;
  limit?: number;
  before?: string;
}

export interface ActivityFilters {
  agent_id?: string;
  status?: AgentRunStatus;
  trigger?: AgentTrigger;
  since?: string;
  limit?: number;
  offset?: number;
}

export interface ChildThreadSummary {
  thread: AgentThread;
  agent_name: string;
  run_id: string | null;
  status: AgentRunStatus | null;
  started_at: string | null;
  finished_at: string | null;
}

export interface CreateRunInput {
  agent_id: string;
  user_id?: string | null;
  thread_id?: string | null;
  routine_id?: string | null;
  parent_run_id?: string | null;
  delegate_agent_id?: string | null;
  depth?: number;
  trigger: AgentTrigger;
  status?: AgentRunStatus;
  summary?: string | null;
  started_at?: string | null;
}

export interface UpdateRunInput {
  thread_id?: string | null;
  status?: AgentRunStatus;
  summary?: string | null;
  error_code?: string | null;
  error_message?: string | null;
  error_step?: string | null;
  tokens?: number;
  started_at?: string | null;
  finished_at?: string | null;
}

export interface CreateNoticeInput {
  org_id: string;
  agent_id?: string | null;
  user_id?: string | null;
  kind: string;
  payload?: Record<string, unknown>;
}

const TS = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const AGENT_COLUMNS = `a.id, a.org_id, a.owner_user_id, a.name, a.description, a.model,
  a.tools, a.tools_mode, a.visibility, a.resources, a.status, a.is_personal,
  (SELECT COALESCE(u.display_name, u.email) FROM users u WHERE u.id = a.owner_user_id) AS owner_label,
  (SELECT u.email FROM users u WHERE u.id = a.owner_user_id) AS owner_email,
  (SELECT u.avatar_url FROM users u WHERE u.id = a.owner_user_id) AS owner_avatar_url,
  (SELECT r.alias FROM model_routes r WHERE r.org_id = a.org_id AND r.model = a.model LIMIT 1) AS model_alias,
  COALESCE((SELECT array_agg(tg.team_id::text ORDER BY tg.team_id)
            FROM agent_team_grants tg WHERE tg.agent_id = a.id), '{}') AS team_ids,
  ${TS("a.deleted_at")} AS deleted_at, ${TS("a.purge_after")} AS purge_after,
  ${TS("a.created_at")} AS created_at, ${TS("a.updated_at")} AS updated_at`;

const THREAD_COLUMNS = `t.id, t.agent_id, t.user_id, t.chat_id, t.title, t.title_locked, t.kind,
  t.parent_thread_id, t.depth, ${TS("t.closed_at")} AS closed_at,
  ${TS("t.created_at")} AS created_at, ${TS("t.last_activity_at")} AS last_activity_at`;

const RUN_COLUMNS = `r.id, r.agent_id, r.user_id, r.thread_id, r.routine_id, r.parent_run_id,
  r.delegate_agent_id, r.depth, r.trigger, r.status, r.summary,
  r.error_code, r.error_message, r.error_step, r.tokens,
  ${TS("r.started_at")} AS started_at, ${TS("r.finished_at")} AS finished_at,
  ${TS("r.created_at")} AS created_at,
  (SELECT name FROM agents WHERE id = r.agent_id) AS agent_name,
  (SELECT name FROM agent_routines WHERE id = r.routine_id) AS routine_name`;

const ARTIFACT_COLUMNS = `d.id, d.run_id, d.parent_run_id, d.agent_id, d.path, d.size,
  d.status, d.inbox_path, d.staging_path, ${TS("d.created_at")} AS created_at`;

const NOTICE_COLUMNS = `n.id, n.org_id, n.agent_id, n.user_id, n.kind, n.payload,
  ${TS("n.read_at")} AS read_at, ${TS("n.created_at")} AS created_at`;

/** Visibility predicate over an `agents` alias. Fixed placeholders:
 *  $1 = org id, $2 = caller is admin, $3 = caller user id. */
function visiblePredicate(alias: string): string {
  // A personal agent belongs to exactly one user: no admin override, no
  // org or team visibility. Everything else follows the grant rules.
  return `(${alias}.org_id = $1 AND (
    ${alias}.owner_user_id = $3
    OR (${alias}.is_personal = false AND (
      $2::boolean
      OR ${alias}.visibility = 'org'
      OR EXISTS (SELECT 1 FROM agent_grants g WHERE g.agent_id = ${alias}.id AND g.user_id = $3)
      OR (${alias}.visibility = 'team' AND EXISTS (
        SELECT 1 FROM agent_team_grants tg
        JOIN team_members tm ON tm.team_id = tg.team_id
        WHERE tg.agent_id = ${alias}.id AND tm.user_id = $3))
    ))
  ))`;
}

function toAgent(row: Record<string, unknown>): Agent {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    owner_user_id: row.owner_user_id as string,
    owner_label: (row.owner_label as string | null) ?? null,
    owner_email: (row.owner_email as string | null) ?? null,
    owner_avatar_url: (row.owner_avatar_url as string | null) ?? null,
    name: row.name as string,
    description: (row.description as string | null) ?? "",
    model: row.model as string,
    model_alias: (row.model_alias as string | null) ?? null,
    tools: (row.tools as AgentToolName[] | null) ?? [],
    tools_mode: (row.tools_mode as AgentToolsMode | null) ?? "selected",
    visibility: row.visibility as AgentVisibility,
    resources: (row.resources as Record<string, unknown> | null) ?? {},
    status: row.status as AgentStatus,
    is_personal: Boolean(row.is_personal),
    team_ids: (row.team_ids as string[] | null) ?? [],
    deleted_at: row.deleted_at === null || row.deleted_at === undefined ? null : pgTimestampToRfc3339(row.deleted_at as string),
    purge_after: row.purge_after === null || row.purge_after === undefined ? null : pgTimestampToRfc3339(row.purge_after as string),
    created_at: pgTimestampToRfc3339(row.created_at as string),
    updated_at: pgTimestampToRfc3339(row.updated_at as string),
  };
}

function toThread(row: Record<string, unknown>): AgentThread {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    user_id: row.user_id as string,
    chat_id: row.chat_id as string,
    title: (row.title as string | null) ?? "",
    title_locked: Boolean(row.title_locked),
    kind: row.kind as AgentThreadKind,
    parent_thread_id: (row.parent_thread_id as string | null) ?? null,
    depth: Number(row.depth ?? 0),
    closed_at: row.closed_at === null || row.closed_at === undefined ? null : pgTimestampToRfc3339(row.closed_at as string),
    created_at: pgTimestampToRfc3339(row.created_at as string),
    last_activity_at: pgTimestampToRfc3339(row.last_activity_at as string),
  };
}

function toRun(row: Record<string, unknown>): AgentRun {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    user_id: (row.user_id as string | null) ?? null,
    thread_id: (row.thread_id as string | null) ?? null,
    routine_id: (row.routine_id as string | null) ?? null,
    parent_run_id: (row.parent_run_id as string | null) ?? null,
    delegate_agent_id: (row.delegate_agent_id as string | null) ?? null,
    depth: Number(row.depth),
    trigger: row.trigger as AgentTrigger,
    status: row.status as AgentRunStatus,
    summary: (row.summary as string | null) ?? null,
    error_code: (row.error_code as string | null) ?? null,
    error_message: (row.error_message as string | null) ?? null,
    error_step: (row.error_step as string | null) ?? null,
    tokens: Number(row.tokens ?? 0),
    started_at: row.started_at === null || row.started_at === undefined ? null : pgTimestampToRfc3339(row.started_at as string),
    finished_at: row.finished_at === null || row.finished_at === undefined ? null : pgTimestampToRfc3339(row.finished_at as string),
    created_at: pgTimestampToRfc3339(row.created_at as string),
    agent_name: (row.agent_name as string | null) ?? null,
    routine_name: (row.routine_name as string | null) ?? null,
  };
}

function toArtifact(row: Record<string, unknown>): AgentDelegationArtifact {
  return {
    id: row.id as string,
    run_id: row.run_id as string,
    parent_run_id: row.parent_run_id as string,
    agent_id: row.agent_id as string,
    path: row.path as string,
    size: Number(row.size ?? 0),
    status: row.status as AgentArtifactStatus,
    inbox_path: (row.inbox_path as string | null) ?? null,
    staging_path: (row.staging_path as string | null) ?? null,
    created_at: pgTimestampToRfc3339(row.created_at as string),
  };
}

function toNotice(row: Record<string, unknown>): AgentNotice {
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    agent_id: (row.agent_id as string | null) ?? null,
    user_id: (row.user_id as string | null) ?? null,
    kind: row.kind as string,
    payload: (row.payload as Record<string, unknown> | null) ?? {},
    read_at: row.read_at === null || row.read_at === undefined ? null : pgTimestampToRfc3339(row.read_at as string),
    created_at: pgTimestampToRfc3339(row.created_at as string),
  };
}

function accessForRole(
  role: AgentRole | null,
  canManage: boolean,
  canUse: boolean = role !== null || canManage,
): AgentAccess {
  return { role, can_manage: canManage, can_use: canUse };
}

/** Short, markdown-stripped thread title from the first non-empty line of a
 *  user message. Never the placeholder "New chat". */
export function deriveTitleFromMessage(message: string): string {
  const first = message.split(/\r?\n/).find((line) => line.trim() !== "") ?? "";
  const text = first
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .replace(/^[-*+]\s+/, "")
    .replace(/^>\s*/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return "";
  const max = 60;
  if (text.length <= max) return text;
  // Cut at a word boundary and mark the cut; a hard 60-character slice
  // ended titles mid-word with no indication that text was dropped.
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  const stem = (space >= max / 2 ? cut.slice(0, space) : cut).replace(/[\s,;:.\-–—]+$/, "");
  return `${stem}…`;
}

/** Default per-agent sandbox budget recorded with every new agent. */
export const DEFAULT_AGENT_RESOURCES = {
  vcpu: 1,
  memory_mb: 2048,
  pids: 256,
  workspace_gib: 50,
} as const;

export class AgentStore {
  private readonly chats: ChatStore;

  constructor(
    private readonly pool: PlatformPool,
    /** Mirrors run lifecycle rows into ClickHouse (agent_traces). */
    private readonly trace?: TraceStore,
    /** The server-writable workspace root; absent: no config files seeded. */
    private readonly workspaceRoot?: string,
  ) {
    this.chats = new ChatStore(pool);
  }

  /** Seeds the workspace config files for a new agent. Best-effort: a
   *  missing volume or a permission error must not fail the create. */
  private async seedWorkspace(agent: { id: string; org_id: string; name: string }): Promise<void> {
    if (this.workspaceRoot === undefined) return;
    try {
      await seedAgentWorkspace(agentWorkspaceDir(this.workspaceRoot, agent.org_id, agent.id), agent);
    } catch {
      // The next turn seeds it again through the runtime path.
    }
  }

  /** Creates the agent, its default thread and that thread's chat journal
   *  row in one transaction. The owner is the caller. */
  async create(user: UserRow, input: CreateAgentInput): Promise<Agent> {
    const id = uuidv7();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO agents (id, org_id, owner_user_id, name, description, model, tools, tools_mode, visibility, resources)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10::jsonb)`,
        [
          id,
          user.org_id,
          user.id,
          input.name,
          input.description ?? "",
          input.model,
          JSON.stringify(input.tools ?? DEFAULT_AGENT_TOOLS),
          input.tools_mode ?? "selected",
          input.visibility ?? "private",
          JSON.stringify(
            input.resources === undefined || Object.keys(input.resources).length === 0
              ? DEFAULT_AGENT_RESOURCES
              : input.resources,
          ),
        ],
      );
      if (input.team_ids !== undefined && input.team_ids.length > 0) {
        await this.replaceTeamGrants(client, user.org_id, id, input.team_ids);
      }
      const chat = await this.chats.createChatOn(client, user.org_id, user.id, "Main thread", null);
      await client.query(
        `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, title_locked, kind)
         VALUES ($1, $2, $3, $4, 'Main thread', false, 'default')`,
        [uuidv7(), id, user.id, chat.id],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      if ((error as { code?: string }).code === "23505") {
        throw ApiError.conflict("name_taken", "you already have an agent with this name");
      }
      throw error;
    } finally {
      client.release();
    }
    const agent = await this.fetchById(user.org_id, id);
    if (agent === null) throw ApiError.internal("agent insert lost its row");
    await this.seedWorkspace(agent);
    return agent;
  }

  /** The org's first enabled model — the default for a personal agent. */
  private async defaultModel(orgId: string): Promise<string | null> {
    const res = await this.pool.query<{ model: string }>(
      "SELECT model FROM model_routes WHERE org_id = $1 AND enabled ORDER BY model LIMIT 1",
      [orgId],
    );
    return res.rows[0]?.model ?? null;
  }

  /** The caller's personal agent, created on first use. One per user, always
   *  private, and exempt from deletion. Returns null when the org has no
   *  enabled model to give it. */
  async ensurePersonalAgent(user: UserRow): Promise<Agent | null> {
    return this.ensurePersonalAgentFor(user.org_id, user.id);
  }

  /** Same, addressed by ids: the chat turn path adopts a plain chat without
   *  loading the full user row. */
  async ensurePersonalAgentFor(orgId: string, userId: string): Promise<Agent | null> {
    const find = async (): Promise<Agent | null> => {
      const res = await this.pool.query<Record<string, unknown>>(
        `SELECT ${AGENT_COLUMNS} FROM agents a
         WHERE a.owner_user_id = $1 AND a.is_personal AND a.status <> 'deleted' LIMIT 1`,
        [userId],
      );
      const row = res.rows[0];
      return row === undefined ? null : toAgent(row);
    };
    const existing = await find();
    if (existing !== null) return existing;

    const model = await this.defaultModel(orgId);
    if (model === null) return null;
    try {
      await this.pool.query(
        `INSERT INTO agents (id, org_id, owner_user_id, name, model, tools, tools_mode, visibility, resources, is_personal)
         VALUES ($1, $2, $3, 'Assistant', $4, $5::jsonb, 'all', 'private', $6::jsonb, true)`,
        [
          uuidv7(),
          orgId,
          userId,
          model,
          JSON.stringify(DEFAULT_AGENT_TOOLS),
          JSON.stringify(DEFAULT_AGENT_RESOURCES),
        ],
      );
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
    }
    const created = await find();
    if (created !== null) await this.seedWorkspace(created);
    return created;
  }

  /** Visibility-filtered list. Active agents by default; archived rows are
   *  opt-in. */
  async list(user: UserRow, options: { includeArchived?: boolean; status?: AgentStatus } = {}): Promise<Agent[]> {
    const params: unknown[] = [user.org_id, user.role === "admin", user.id];
    let where = visiblePredicate("a");
    if (options.status !== undefined) {
      params.push(options.status);
      where += ` AND a.status = $${params.length}`;
    } else if (options.includeArchived !== true) {
      where += ` AND a.status = 'active'`;
    } else {
      where += ` AND a.status IN ('active', 'archived', 'deleting')`;
    }
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${AGENT_COLUMNS} FROM agents a WHERE ${where} ORDER BY a.created_at DESC`,
      params,
    );
    return res.rows.map(toAgent);
  }

  /** Loads one visible agent; invisible and missing agents are the same 404. */
  async get(user: UserRow, agentId: string): Promise<Agent> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${AGENT_COLUMNS} FROM agents a WHERE a.id = $4 AND ${visiblePredicate("a")}`,
      [user.org_id, user.role === "admin", user.id, agentId],
    );
    const row = res.rows[0];
    if (row === undefined) throw ApiError.notFound("no such agent");
    return toAgent(row);
  }

  /** Resolves the caller's grant role and capability flags for one agent.
   *  Admins resolve as owner. */
  async access(user: UserRow, agent: Agent): Promise<AgentAccess> {
    if (user.role === "admin" || agent.owner_user_id === user.id) {
      return accessForRole("owner", true);
    }
    const direct = await this.pool.query<{ role: AgentRole }>(
      "SELECT role FROM agent_grants WHERE agent_id = $1 AND user_id = $2",
      [agent.id, user.id],
    );
    if (direct.rows[0]) return accessForRole(direct.rows[0].role, false);
    const team = await this.pool.query<{ role: AgentRole }>(
      `SELECT tg.role FROM agent_team_grants tg
       JOIN team_members tm ON tm.team_id = tg.team_id
       WHERE tg.agent_id = $1 AND tm.user_id = $2
       ORDER BY CASE tg.role WHEN 'editor' THEN 0 WHEN 'user' THEN 1 ELSE 2 END
       LIMIT 1`,
      [agent.id, user.id],
    );
    if (team.rows[0]) return accessForRole(team.rows[0].role, false);
    if (agent.visibility === "org") return accessForRole(null, false, true);
    return accessForRole(null, false);
  }

  /** Loads the agent and enforces can_use (read/chat) or can_manage
   *  (configuration, lifecycle). */
  async requireAccess(user: UserRow, agentId: string, mode: "use" | "manage"): Promise<{ agent: Agent; access: AgentAccess }> {
    const agent = await this.get(user, agentId);
    const access = await this.access(user, agent);
    if (mode === "manage" ? !access.can_manage : !access.can_use) throw ApiError.forbidden();
    return { agent, access };
  }

  async update(user: UserRow, agentId: string, patch: UpdateAgentInput): Promise<Agent> {
    const { agent } = await this.requireAccess(user, agentId, "manage");
    const sets: string[] = [];
    const params: unknown[] = [agent.org_id, agentId];
    const add = (column: string, value: unknown, cast = ""): void => {
      params.push(value);
      sets.push(`${column} = $${params.length}${cast}`);
    };
    if (patch.name !== undefined) add("name", patch.name);
    if (patch.description !== undefined) add("description", patch.description);
    if (patch.tools_mode !== undefined) add("tools_mode", patch.tools_mode);
    if (patch.model !== undefined) add("model", patch.model);
    if (patch.tools !== undefined) add("tools", JSON.stringify(patch.tools), "::jsonb");
    if (patch.visibility !== undefined) {
      if (agent.is_personal && patch.visibility !== "private") {
        throw ApiError.badRequest("the personal agent is always private");
      }
      add("visibility", patch.visibility);
    }
    if (patch.resources !== undefined) add("resources", JSON.stringify(patch.resources), "::jsonb");
    if (sets.length === 0 && patch.team_ids === undefined) return agent;
    if (sets.length > 0) {
      sets.push("updated_at = now()");
      try {
        await this.pool.query(
          `UPDATE agents SET ${sets.join(", ")} WHERE org_id = $1 AND id = $2`,
          params,
        );
      } catch (error) {
        if ((error as { code?: string }).code === "23505") {
          throw ApiError.conflict("name_taken", "you already have an agent with this name");
        }
        throw error;
      }
    }
    if (patch.team_ids !== undefined) {
      await this.replaceTeamGrants(this.pool, agent.org_id, agentId, patch.team_ids);
    }
    const updated = await this.fetchById(agent.org_id, agentId);
    if (updated === null) throw ApiError.notFound("no such agent");
    return updated;
  }

  /** Writes the agent's own description. The caller is the agent itself, so
   *  this path checks no grant. */
  async setDescription(agentId: string, description: string): Promise<string> {
    const res = await this.pool.query<{ description: string }>(
      "UPDATE agents SET description = $2, updated_at = now() WHERE id = $1 RETURNING description",
      [agentId, description],
    );
    const row = res.rows[0];
    if (row === undefined) throw ApiError.notFound("no such agent");
    return row.description;
  }

  /** Replaces an agent's team grants after checking every team belongs to
   *  the same organization. */
  private async replaceTeamGrants(
    db: { query: (text: string, values?: unknown[]) => Promise<{ rowCount: number | null; rows: unknown[] }> },
    orgId: string,
    agentId: string,
    teamIds: string[],
  ): Promise<void> {
    const unique = [...new Set(teamIds)];
    if (unique.length > 0) {
      const valid = await db.query(
        "SELECT id FROM teams WHERE org_id = $1 AND id = ANY($2::uuid[])",
        [orgId, unique],
      );
      if (valid.rowCount !== unique.length) throw ApiError.badRequest("unknown team");
    }
    await db.query("DELETE FROM agent_team_grants WHERE agent_id = $1", [agentId]);
    for (const teamId of unique) {
      await db.query(
        `INSERT INTO agent_team_grants (agent_id, team_id, role) VALUES ($1, $2, 'user')
         ON CONFLICT (agent_id, team_id) DO NOTHING`,
        [agentId, teamId],
      );
    }
  }

  async archive(user: UserRow, agentId: string): Promise<Agent> {
    const { agent } = await this.requireAccess(user, agentId, "manage");
    if (agent.is_personal) throw ApiError.badRequest("the personal agent cannot be archived");
    await this.pool.query(
      "UPDATE agents SET status = 'archived', updated_at = now() WHERE org_id = $1 AND id = $2",
      [agent.org_id, agentId],
    );
    return this.fetchOrThrow(agent.org_id, agentId);
  }

  async restore(user: UserRow, agentId: string): Promise<Agent> {
    const { agent } = await this.requireAccess(user, agentId, "manage");
    await this.pool.query(
      `UPDATE agents SET status = 'active', deleted_at = NULL, purge_after = NULL, updated_at = now()
       WHERE org_id = $1 AND id = $2`,
      [agent.org_id, agentId],
    );
    return this.fetchOrThrow(agent.org_id, agentId);
  }

  /** Phase one of deletion: hide the agent and start the org grace period.
   *  Rows stay until purge. */
  async markDeleted(user: UserRow, agentId: string): Promise<Agent> {
    const { agent } = await this.requireAccess(user, agentId, "manage");
    if (agent.is_personal) throw ApiError.badRequest("the personal agent cannot be deleted");
    const days = await this.graceDays(agent.org_id);
    await this.pool.query(
      `UPDATE agents
       SET status = 'deleting', deleted_at = now(), purge_after = now() + ($3::int * interval '1 day'), updated_at = now()
       WHERE org_id = $1 AND id = $2`,
      [agent.org_id, agentId, days],
    );
    return this.fetchOrThrow(agent.org_id, agentId);
  }

  /** Phase two: hard-delete the agent row and its thread chats; grants,
   *  threads, runs, chunks and notices cascade. The caller removes the
   *  workspace directory. */
  async purge(user: UserRow, agentId: string): Promise<void> {
    const { agent } = await this.requireAccess(user, agentId, "manage");
    await this.purgeById(agent.org_id, agentId);
  }

  /** Phase two without an access check: the deletion sweeper and the
   *  owner-initiated purge route both land here. */
  async purgeById(orgId: string, agentId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const chats = await client.query<{ chat_id: string }>(
        "SELECT chat_id FROM agent_threads WHERE agent_id = $1",
        [agentId],
      );
      await client.query("DELETE FROM agents WHERE org_id = $1 AND id = $2", [orgId, agentId]);
      for (const row of chats.rows) {
        await client.query("DELETE FROM chats WHERE id = $1", [row.chat_id]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  /** Agents whose grace period elapsed; the scheduler purges them. */
  async dueForPurge(): Promise<{ id: string; org_id: string }[]> {
    const res = await this.pool.query<{ id: string; org_id: string }>(
      `SELECT id, org_id FROM agents
       WHERE status = 'deleting' AND purge_after IS NOT NULL AND purge_after <= now()
       ORDER BY purge_after ASC LIMIT 50`,
    );
    return res.rows;
  }

  /** A deletion export: the agent's definition, threads, routines and the
   *  newest runs. Transcripts stay in the chat journal rows listed by id. */
  async export(orgId: string, agentId: string): Promise<Record<string, unknown>> {
    const agent = await this.fetchOrThrow(orgId, agentId);
    const [threads, routines, runs] = await Promise.all([
      this.listThreads(agentId, agent.owner_user_id, { includeRoutineRuns: true }),
      this.listRoutines(agentId),
      this.listRuns(agentId, { limit: 200 }),
    ]);
    return {
      exported_at: new Date().toISOString(),
      agent,
      threads,
      routines,
      runs,
    };
  }

  /** Reads the org's configured grace period when the optional
   *  agent_settings table exists; otherwise the 30-day default. */
  private async graceDays(orgId: string): Promise<number> {
    const present = await this.pool.query<{ present: boolean }>(
      "SELECT to_regclass('public.agent_settings') IS NOT NULL AS present",
    );
    if (!present.rows[0]?.present) return DEFAULT_GRACE_DAYS;
    const row = await this.pool.query<Record<string, unknown>>(
      "SELECT * FROM agent_settings WHERE org_id = $1",
      [orgId],
    );
    const raw = row.rows[0]?.grace_days ?? row.rows[0]?.deletion_grace_days;
    const days = Number(raw);
    return Number.isFinite(days) && days > 0 ? days : DEFAULT_GRACE_DAYS;
  }

  private async fetchById(orgId: string, agentId: string): Promise<Agent | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${AGENT_COLUMNS} FROM agents a WHERE a.org_id = $1 AND a.id = $2`,
      [orgId, agentId],
    );
    return res.rows[0] === undefined ? null : toAgent(res.rows[0]);
  }

  private async fetchOrThrow(orgId: string, agentId: string): Promise<Agent> {
    const agent = await this.fetchById(orgId, agentId);
    if (agent === null) throw ApiError.notFound("no such agent");
    return agent;
  }

  /** Loads an agent without a caller check; routes and the runtime call this
   *  only after authorization. */
  async fetchAgent(agentId: string): Promise<Agent> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${AGENT_COLUMNS} FROM agents a WHERE a.id = $1`,
      [agentId],
    );
    const row = res.rows[0];
    if (row === undefined) throw ApiError.notFound("no such agent");
    return toAgent(row);
  }

  /** Creates a chat journal row plus its agent_threads row in one
   *  transaction. The thread is private to `userId`; the chat journal row is
   *  owned by that user too. */
  async createThread(
    agentId: string,
    userId: string,
    title: string,
    kind: AgentThreadKind = "thread",
  ): Promise<AgentThread> {
    const agent = await this.fetchAgent(agentId);
    const id = uuidv7();
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const chat = await this.chats.createChatOn(
        client,
        agent.org_id,
        userId,
        title.trim() === "" ? null : title,
        null,
      );
      await client.query(
        `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, title_locked, kind)
         VALUES ($1, $2, $3, $4, $5, false, $6)`,
        [id, agentId, userId, chat.id, title, kind],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return this.fetchThread(agentId, userId, id);
  }

  /** Creates a delegated child thread under an existing node. The edge is
   *  parent_thread_id; depth is the parent's depth plus one. */
  async createChildThread(
    parentThreadId: string,
    agentId: string,
    userId: string,
    title: string,
    titleLocked = false,
  ): Promise<AgentThread> {
    const agent = await this.fetchAgent(agentId);
    const parent = await this.pool.query<{ depth: number; closed_at: Date | null }>(
      "SELECT depth, closed_at FROM agent_threads WHERE id = $1",
      [parentThreadId],
    );
    const parentRow = parent.rows[0];
    if (parentRow === undefined) throw ApiError.notFound("no such parent thread");
    if (parentRow.closed_at !== null) throw ApiError.badRequest("the parent thread is closed");
    const id = uuidv7();
    const depth = Number(parentRow.depth) + 1;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const chat = await this.chats.createChatOn(
        client,
        agent.org_id,
        userId,
        title.trim() === "" ? null : title,
        null,
      );
      await client.query(
        `INSERT INTO agent_threads
           (id, agent_id, user_id, chat_id, title, title_locked, kind, parent_thread_id, depth)
         VALUES ($1, $2, $3, $4, $5, $8, 'delegated', $6, $7)`,
        [id, agentId, userId, chat.id, title, parentThreadId, depth, titleLocked],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return this.fetchThread(agentId, userId, id);
  }

  /** The user's default thread with this agent, created on first use. A
   *  shared agent therefore gives each user their own default thread. */
  async ensureDefaultThread(agentId: string, userId: string): Promise<AgentThread> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${THREAD_COLUMNS} FROM agent_threads t
       WHERE t.agent_id = $1 AND t.user_id = $2 AND t.kind = 'default'`,
      [agentId, userId],
    );
    const row = res.rows[0];
    if (row !== undefined) return toThread(row);
    try {
      return await this.createThread(agentId, userId, "Main thread", "default");
    } catch (error) {
      // A concurrent first turn may have created it between the two queries.
      const again = await this.pool.query<Record<string, unknown>>(
        `SELECT ${THREAD_COLUMNS} FROM agent_threads t
         WHERE t.agent_id = $1 AND t.user_id = $2 AND t.kind = 'default'`,
        [agentId, userId],
      );
      const raced = again.rows[0];
      if (raced !== undefined) return toThread(raced);
      throw error;
    }
  }

  /** The caller's threads with this agent: default first, then most recent
   *  activity. Routine-run and delegated threads are execution transcripts
   *  and stay out of the user-facing list unless explicitly requested. */
  async listThreads(
    agentId: string,
    userId: string,
    options: { includeRoutineRuns?: boolean } = {},
  ): Promise<AgentThread[]> {
    let where = "t.agent_id = $1 AND t.user_id = $2";
    if (options.includeRoutineRuns !== true) where += " AND t.kind NOT IN ('routine_run', 'delegated')";
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${THREAD_COLUMNS} FROM agent_threads t
       WHERE ${where}
       ORDER BY (t.kind = 'default') DESC, t.last_activity_at DESC, t.created_at DESC`,
      [agentId, userId],
    );
    return res.rows.map(toThread);
  }

  async getThread(agentId: string, userId: string, threadId: string): Promise<AgentThread> {
    return this.fetchThread(agentId, userId, threadId);
  }

  /** One thread row by id without caller scoping. Tree tools resolve a child
   *  by id and check the parent edge themselves. */
  async threadById(threadId: string): Promise<AgentThread | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${THREAD_COLUMNS} FROM agent_threads t WHERE t.id = $1`,
      [threadId],
    );
    const row = res.rows[0];
    return row === undefined ? null : toThread(row);
  }

  /** One thread row by its chat, without caller scoping: the thread routes
   *  authorize the chat first and then act on the thread behind it. */
  async threadByChatId(chatId: string): Promise<AgentThread | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${THREAD_COLUMNS} FROM agent_threads t WHERE t.chat_id = $1`,
      [chatId],
    );
    const row = res.rows[0];
    return row === undefined ? null : toThread(row);
  }

  /** Renames a thread and locks the title against regeneration. */
  async renameThread(agentId: string, userId: string, threadId: string, title: string): Promise<AgentThread> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query<{ chat_id: string }>(
        `UPDATE agent_threads SET title = $4, title_locked = true
         WHERE agent_id = $1 AND user_id = $2 AND id = $3 RETURNING chat_id`,
        [agentId, userId, threadId, title],
      );
      const row = res.rows[0];
      if (row === undefined) throw ApiError.notFound("no such thread");
      await client.query("UPDATE chats SET title = $2 WHERE id = $1", [row.chat_id, title]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    return this.fetchThread(agentId, userId, threadId);
  }

  /** Moves the thread's activity marker (called when a turn commits). */
  async touchThread(agentId: string, threadId: string): Promise<void> {
    await this.pool.query(
      "UPDATE agent_threads SET last_activity_at = now() WHERE agent_id = $1 AND id = $2",
      [agentId, threadId],
    );
  }

  /** Fills an empty, unlocked thread title from the first user message and
   *  mirrors it onto the chat journal row. A manual rename locks the title
   *  and wins over this path. */
  async deriveThreadTitle(agentId: string, threadId: string, message: string): Promise<void> {
    const title = deriveTitleFromMessage(message);
    if (title === "") return;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const res = await client.query<{ chat_id: string }>(
        `UPDATE agent_threads SET title = $3
         WHERE agent_id = $1 AND id = $2 AND title = '' AND title_locked = false
         RETURNING chat_id`,
        [agentId, threadId, title],
      );
      const row = res.rows[0];
      if (row !== undefined) {
        await client.query("UPDATE chats SET title = $2 WHERE id = $1", [row.chat_id, title]);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  private async fetchThread(agentId: string, userId: string, threadId: string): Promise<AgentThread> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${THREAD_COLUMNS} FROM agent_threads t
       WHERE t.agent_id = $1 AND t.user_id = $2 AND t.id = $3`,
      [agentId, userId, threadId],
    );
    const row = res.rows[0];
    if (row === undefined) throw ApiError.notFound("no such thread");
    return toThread(row);
  }

  async listRuns(agentId: string, filters: RunFilters = {}): Promise<AgentRun[]> {
    const params: unknown[] = [agentId];
    let where = "r.agent_id = $1";
    if (filters.status !== undefined) {
      params.push(filters.status);
      where += ` AND r.status = $${params.length}`;
    }
    if (filters.trigger !== undefined) {
      params.push(filters.trigger);
      where += ` AND r.trigger = $${params.length}`;
    }
    if (filters.before !== undefined) {
      params.push(filters.before);
      where += ` AND r.created_at < $${params.length}::timestamptz`;
    }
    const limit = Math.max(1, Math.min(200, filters.limit ?? 50));
    params.push(limit);
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs r WHERE ${where}
       ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(toRun);
  }

  async getRun(runId: string): Promise<AgentRun> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs r WHERE r.id = $1`,
      [runId],
    );
    const row = res.rows[0];
    if (row === undefined) throw ApiError.notFound("no such run");
    return toRun(row);
  }

  /** Derived run-detail steps: transcript tool calls and assistant text in
   *  the run window, plus files recorded by an agent workspace turn. */
  async runSteps(run: AgentRun): Promise<AgentRunStep[]> {
    const steps: AgentRunStep[] = [];
    if (run.thread_id !== null) {
      const thread = await this.pool.query<{ chat_id: string }>(
        "SELECT chat_id FROM agent_threads WHERE id = $1",
        [run.thread_id],
      );
      const chatId = thread.rows[0]?.chat_id;
      if (chatId !== undefined) {
        const since = run.started_at ?? run.created_at;
        const res = await this.pool.query<{
          seq: string;
          type: string;
          payload: Record<string, unknown>;
          created_at: Date;
        }>(
          `SELECT seq, type, payload, created_at FROM thread_events
           WHERE chat_id = $1 AND created_at >= $2::timestamptz
             AND ($3::timestamptz IS NULL OR created_at <= $3::timestamptz)
           ORDER BY seq ASC LIMIT 200`,
          [chatId, since, run.finished_at],
        );
        for (const row of res.rows) {
          const ts = row.created_at.toISOString();
          if (row.type === "user_message") {
            const text = typeof row.payload.content === "string" ? row.payload.content : "";
            if (text.trim() !== "") {
              steps.push({ type: "user_message", seq: Number(row.seq), ts, text: text.slice(0, 4_000) });
            }
          } else if (row.type === "assistant_message") {
            const blocks = Array.isArray(row.payload.blocks)
              ? (row.payload.blocks as { type?: string; text?: string }[])
              : [];
            for (const block of blocks) {
              if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
                steps.push({ type: "assistant_text", seq: Number(row.seq), ts, text: block.text.slice(0, 2_000) });
              }
            }
          } else if (row.type === "tool_result") {
            steps.push({
              type: "tool_call",
              seq: Number(row.seq),
              ts,
              name: typeof row.payload.name === "string" ? row.payload.name : "tool",
              call_id: typeof row.payload.call_id === "string" ? row.payload.call_id : undefined,
              is_error: row.payload.is_error === true,
              text: typeof row.payload.content === "string" ? row.payload.content.slice(0, 500) : "",
            });
          }
        }
      }
    }
    const files = await this.pool.query<{ paths: string[]; finished_at: Date | null }>(
      `SELECT paths, finished_at FROM agent_workspace_turns WHERE run_id = $1 ORDER BY started_at ASC`,
      [run.id],
    );
    for (const row of files.rows) {
      if (row.paths.length === 0) continue;
      steps.push({
        type: "file",
        ts: (row.finished_at ?? new Date()).toISOString(),
        paths: row.paths,
      });
    }
    return steps;
  }

  /** Creates a run row. A2 calls this before admission; the returned row is
   *  the durable run identity. */

  /** The oldest queued/running run for a chat journal row. Tools run inside
   *  a turn use this to resolve the run they belong to. */
  async runningRunForChat(chatId: string): Promise<AgentRun | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs r
       JOIN agent_threads t ON t.id = r.thread_id
       WHERE t.chat_id = $1 AND r.status IN ('queued', 'running')
       ORDER BY r.created_at ASC, r.id ASC LIMIT 1`,
      [chatId],
    );
    return res.rows[0] === undefined ? null : toRun(res.rows[0]);
  }

  /** The oldest queued/running run for one agent thread. A chat turn adopts
   *  an open run instead of opening a second one. */
  async runningRunForThread(threadId: string): Promise<AgentRun | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs r
       WHERE r.thread_id = $1 AND r.status IN ('queued', 'running')
       ORDER BY r.created_at ASC, r.id ASC LIMIT 1`,
      [threadId],
    );
    return res.rows[0] === undefined ? null : toRun(res.rows[0]);
  }

  /** Direct children of one run, oldest first. */
  async childRuns(parentRunId: string): Promise<AgentRun[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs r
       WHERE r.parent_run_id = $1 ORDER BY r.created_at ASC, r.id ASC`,
      [parentRunId],
    );
    return res.rows.map(toRun);
  }

  /** Child threads of one node (decision 17: the count bounds the tree
   *  shape, so it is per thread, not per run). Closed children still count. */
  async childCount(parentThreadId: string): Promise<number> {
    const res = await this.pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM agent_threads WHERE parent_thread_id = $1",
      [parentThreadId],
    );
    return Number(res.rows[0]?.count ?? 0);
  }

  /** Direct children of one node with the latest run's status and times. */
  async childThreadSummaries(parentThreadId: string): Promise<ChildThreadSummary[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${THREAD_COLUMNS}, a.name AS agent_name,
              r.id AS run_id, r.status AS run_status,
              ${TS("COALESCE(r.started_at, r.created_at)")} AS run_started_at,
              ${TS("r.finished_at")} AS run_finished_at
       FROM agent_threads t
       JOIN agents a ON a.id = t.agent_id
       LEFT JOIN LATERAL (
         SELECT id, status, started_at, created_at, finished_at
         FROM agent_runs WHERE thread_id = t.id
         ORDER BY created_at DESC, id DESC LIMIT 1
       ) r ON true
       WHERE t.parent_thread_id = $1
       ORDER BY t.created_at ASC, t.id ASC`,
      [parentThreadId],
    );
    return res.rows.map((row) => ({
      thread: toThread(row),
      agent_name: row.agent_name as string,
      run_id: (row.run_id as string | null) ?? null,
      status: (row.run_status as AgentRunStatus | null) ?? null,
      started_at: (row.run_started_at as string | null) ?? null,
      finished_at: (row.run_finished_at as string | null) ?? null,
    }));
  }

  /** Queued or running runs in one node's subtree, with their chat ids. */
  async activeRunsInSubtree(
    threadId: string,
  ): Promise<{ run_id: string; thread_id: string; chat_id: string }[]> {
    const res = await this.pool.query<{ run_id: string; thread_id: string; chat_id: string }>(
      `WITH RECURSIVE tree AS (
         SELECT id FROM agent_threads WHERE id = $1
         UNION ALL
         SELECT child.id FROM agent_threads child JOIN tree ON child.parent_thread_id = tree.id
       )
       SELECT r.id AS run_id, r.thread_id, t.chat_id
       FROM agent_runs r JOIN agent_threads t ON t.id = r.thread_id
       WHERE r.thread_id IN (SELECT id FROM tree) AND r.status IN ('queued', 'running')
       ORDER BY r.created_at ASC, r.id ASC`,
      [threadId],
    );
    return res.rows;
  }

  /** The node and every descendant, root first. */
  async subtree(threadId: string): Promise<AgentThread[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `WITH RECURSIVE tree AS (
         SELECT t.*, 0 AS distance FROM agent_threads t WHERE t.id = $1
         UNION ALL
         SELECT child.*, tree.distance + 1
         FROM agent_threads child JOIN tree ON child.parent_thread_id = tree.id
         WHERE tree.distance < 64
       )
       SELECT ${THREAD_COLUMNS} FROM tree t ORDER BY t.distance ASC, t.created_at ASC`,
      [threadId],
    );
    return res.rows.map(toThread);
  }

  /** Cancels the in-flight runs of the node and every descendant. The nodes
   *  stay addressable; only the runs stop. */
  async cancelSubtree(threadId: string): Promise<number> {
    const res = await this.pool.query(
      `WITH RECURSIVE tree AS (
         SELECT id FROM agent_threads WHERE id = $1
         UNION ALL
         SELECT child.id FROM agent_threads child JOIN tree ON child.parent_thread_id = tree.id
       )
       UPDATE agent_runs SET status = 'cancelled', finished_at = now()
       WHERE thread_id IN (SELECT id FROM tree) AND status IN ('queued', 'running')`,
      [threadId],
    );
    return res.rowCount ?? 0;
  }

  /** Cancels the subtree and stamps closed_at on every node. Deliveries stop
   *  because delivery checks closed_at. Rows and attachments stay. */
  async closeSubtree(threadId: string): Promise<number> {
    await this.cancelSubtree(threadId);
    const res = await this.pool.query(
      `WITH RECURSIVE tree AS (
         SELECT id FROM agent_threads WHERE id = $1
         UNION ALL
         SELECT child.id FROM agent_threads child JOIN tree ON child.parent_thread_id = tree.id
       )
       UPDATE agent_threads SET closed_at = COALESCE(closed_at, now())
       WHERE id IN (SELECT id FROM tree) AND closed_at IS NULL`,
      [threadId],
    );
    return res.rowCount ?? 0;
  }

  /** Walks parent_run_id from one run to the root, returning every ancestor
   *  run (nearest first). */
  async ancestorRuns(runId: string): Promise<AgentRun[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `WITH RECURSIVE chain AS (
         SELECT r.*, 1 AS distance FROM agent_runs r WHERE r.id = $1
         UNION ALL
         SELECT parent.*, chain.distance + 1
         FROM agent_runs parent JOIN chain ON parent.id = chain.parent_run_id
         WHERE chain.parent_run_id IS NOT NULL AND chain.distance < 64
       )
       SELECT ${RUN_COLUMNS} FROM chain r
       ORDER BY r.distance ASC`,
      [runId],
    );
    return res.rows.map(toRun);
  }

  async createArtifact(input: {
    run_id: string;
    parent_run_id: string;
    agent_id: string;
    path: string;
    size: number;
    status: AgentArtifactStatus;
    inbox_path?: string | null;
    staging_path?: string | null;
  }): Promise<AgentDelegationArtifact> {
    const res = await this.pool.query<Record<string, unknown>>(
      `WITH d AS (
         INSERT INTO agent_delegation_artifacts
           (id, run_id, parent_run_id, agent_id, path, size, status, inbox_path, staging_path)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (run_id, path) DO UPDATE SET
           size = EXCLUDED.size, status = EXCLUDED.status,
           inbox_path = EXCLUDED.inbox_path, staging_path = EXCLUDED.staging_path
         RETURNING *)
       SELECT ${ARTIFACT_COLUMNS} FROM d`,
      [
        uuidv7(),
        input.run_id,
        input.parent_run_id,
        input.agent_id,
        input.path,
        input.size,
        input.status,
        input.inbox_path ?? null,
        input.staging_path ?? null,
      ],
    );
    return toArtifact(res.rows[0]!);
  }

  async listArtifacts(runId: string): Promise<AgentDelegationArtifact[]> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${ARTIFACT_COLUMNS} FROM agent_delegation_artifacts d
       WHERE d.run_id = $1 OR d.parent_run_id = $1
       ORDER BY d.created_at ASC, d.path ASC`,
      [runId],
    );
    return res.rows.map(toArtifact);
  }

  async createRun(input: CreateRunInput): Promise<AgentRun> {
    const id = uuidv7();
    const res = await this.pool.query<Record<string, unknown>>(
      `WITH r AS (
         INSERT INTO agent_runs
           (id, agent_id, user_id, thread_id, routine_id, parent_run_id, delegate_agent_id, depth, trigger, status, summary, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING *)
       SELECT ${RUN_COLUMNS} FROM r`,
      [
        id,
        input.agent_id,
        input.user_id ?? null,
        input.thread_id ?? null,
        input.routine_id ?? null,
        input.parent_run_id ?? null,
        input.delegate_agent_id ?? null,
        input.depth ?? 0,
        input.trigger,
        input.status ?? "queued",
        input.summary ?? null,
        input.started_at ?? null,
      ],
    );
    const run = toRun(res.rows[0]!);
    this.mirrorRun(run);
    return run;
  }

  async updateRun(runId: string, patch: UpdateRunInput): Promise<AgentRun> {
    const columns: Record<keyof UpdateRunInput, string> = {
      thread_id: "thread_id",
      status: "status",
      summary: "summary",
      error_code: "error_code",
      error_message: "error_message",
      error_step: "error_step",
      tokens: "tokens",
      started_at: "started_at",
      finished_at: "finished_at",
    };
    const sets: string[] = [];
    const params: unknown[] = [runId];
    for (const key of Object.keys(columns) as (keyof UpdateRunInput)[]) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      params.push(patch[key]);
      sets.push(`${columns[key]} = $${params.length}`);
    }
    if (sets.length === 0) return this.getRun(runId);
    const res = await this.pool.query<Record<string, unknown>>(
      `WITH r AS (
         UPDATE agent_runs SET ${sets.join(", ")} WHERE id = $1 RETURNING *)
       SELECT ${RUN_COLUMNS} FROM r`,
      params,
    );
    const row = res.rows[0];
    if (row === undefined) throw ApiError.notFound("no such run");
    const run = toRun(row);
    this.mirrorRun(run);
    return run;
  }

  /** Mirrors one run row into ClickHouse; best-effort and never blocking. */
  private mirrorRun(run: AgentRun): void {
    if (this.trace === undefined) return;
    void this.runTraceContext(run.agent_id, run.thread_id)
      .then((ctx) => {
        if (ctx === null) return;
        return this.trace!.recordTrace({
          trace_id: run.id,
          org_id: ctx.org_id,
          user_id: run.user_id,
          agent_id: run.agent_id,
          agent_name: ctx.agent_name,
          session_id: ctx.chat_id,
          thread_id: run.thread_id,
          parent_trace_id: run.parent_run_id,
          routine_id: run.routine_id,
          trigger: run.trigger,
          status: run.status,
          name: ctx.agent_name,
          summary: run.summary ?? "",
          error: run.error_message ?? "",
          started_at: new Date(run.started_at ?? run.created_at),
          finished_at: run.finished_at === null ? null : new Date(run.finished_at),
        });
      })
      .catch(() => {});
  }

  private async runTraceContext(
    agentId: string,
    threadId: string | null,
  ): Promise<{ org_id: string; agent_name: string; chat_id: string | null } | null> {
    const res = await this.pool.query<{ org_id: string; agent_name: string; chat_id: string | null }>(
      `SELECT a.org_id, a.name AS agent_name, t.chat_id
       FROM agents a LEFT JOIN agent_threads t ON t.id = $2
       WHERE a.id = $1`,
      [agentId, threadId],
    );
    return res.rows[0] ?? null;
  }

  /** The chat's running run with the trace context the tool hook needs. */
  async runningRunTraceForChat(chatId: string): Promise<{
    run_id: string;
    org_id: string;
    user_id: string | null;
    session_id: string;
    agent_id: string;
    agent_name: string;
  } | null> {
    const res = await this.pool.query<{
      run_id: string;
      org_id: string;
      user_id: string | null;
      session_id: string;
      agent_id: string;
      agent_name: string;
    }>(
      `SELECT r.id AS run_id, a.org_id, r.user_id, t.chat_id AS session_id, r.agent_id, a.name AS agent_name
       FROM agent_runs r
       JOIN agent_threads t ON t.id = r.thread_id
       JOIN agents a ON a.id = r.agent_id
       WHERE t.chat_id = $1 AND r.status IN ('queued', 'running')
       ORDER BY r.created_at ASC, r.id ASC LIMIT 1`,
      [chatId],
    );
    return res.rows[0] ?? null;
  }

  /** Org activity log with the agent name. When a viewer is supplied the
   *  same visibility predicate as the agent list applies. */
  async listActivity(
    orgId: string,
    filters: ActivityFilters = {},
    viewer?: UserRow,
  ): Promise<AgentActivityEntry[]> {
    const params: unknown[] = [orgId];
    let where = "a.org_id = $1";
    if (viewer !== undefined) {
      params.push(viewer.role === "admin", viewer.id);
      where += ` AND ${visiblePredicate("a")}`;
    }
    if (filters.agent_id !== undefined) {
      params.push(filters.agent_id);
      where += ` AND r.agent_id = $${params.length}`;
    }
    if (filters.status !== undefined) {
      params.push(filters.status);
      where += ` AND r.status = $${params.length}`;
    }
    if (filters.trigger !== undefined) {
      params.push(filters.trigger);
      where += ` AND r.trigger = $${params.length}`;
    }
    if (filters.since !== undefined) {
      params.push(filters.since);
      where += ` AND r.created_at >= $${params.length}::timestamptz`;
    }
    const limit = Math.max(1, Math.min(200, filters.limit ?? 50));
    const offset = Math.max(0, filters.offset ?? 0);
    params.push(limit, offset);
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${RUN_COLUMNS}, a.name AS agent_name
       FROM agent_runs r JOIN agents a ON a.id = r.agent_id
       WHERE ${where}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return res.rows.map((row) => ({ ...toRun(row), agent_name: row.agent_name as string }));
  }

  async listRoutineRuns(
    agentId: string,
    routineId: string,
    filters: { limit?: number; before?: string } = {},
  ): Promise<AgentRun[]> {
    const params: unknown[] = [agentId, routineId];
    let where = "r.agent_id = $1 AND r.routine_id = $2";
    if (filters.before !== undefined) {
      params.push(filters.before);
      where += ` AND r.created_at < $${params.length}::timestamptz`;
    }
    const limit = Math.max(1, Math.min(200, filters.limit ?? 50));
    params.push(limit);
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs r WHERE ${where}
       ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(toRun);
  }

  async listRoutines(agentId: string): Promise<AgentRoutine[]> {
    return listRoutines(this.pool, agentId);
  }

  async getRoutine(agentId: string, routineId: string): Promise<AgentRoutine> {
    return getRoutine(this.pool, agentId, routineId);
  }

  async createRoutine(agentId: string, input: CreateRoutineInput): Promise<AgentRoutine> {
    return createRoutine(this.pool, agentId, input);
  }

  async updateRoutine(agentId: string, routineId: string, patch: UpdateRoutineInput): Promise<AgentRoutine> {
    return updateRoutine(this.pool, agentId, routineId, patch);
  }

  async deleteRoutine(agentId: string, routineId: string): Promise<void> {
    return deleteRoutine(this.pool, agentId, routineId);
  }

  async createOccurrence(routineId: string, scheduledFor: Date | string): Promise<AgentRoutineOccurrence> {
    return createOccurrence(this.pool, routineId, scheduledFor);
  }

  async listOccurrences(routineId: string, limit?: number): Promise<AgentRoutineOccurrence[]> {
    return listOccurrences(this.pool, routineId, limit);
  }

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
    const res = await this.pool.query<Record<string, unknown>>(
      `WITH n AS (
         UPDATE agent_notices SET read_at = COALESCE(read_at, now())
         WHERE id = $1 AND user_id = $2 RETURNING *)
       SELECT ${NOTICE_COLUMNS} FROM n`,
      [noticeId, userId],
    );
    const row = res.rows[0];
    if (row === undefined) throw ApiError.notFound("no such notice");
    return toNotice(row);
  }

  async markNoticeUnread(userId: string, noticeId: string): Promise<AgentNotice> {
    const res = await this.pool.query<Record<string, unknown>>(
      `WITH n AS (
         UPDATE agent_notices SET read_at = NULL
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
        JSON.stringify(input.payload ?? {}),
      ],
    );
    return toNotice(res.rows[0]!);
  }

  async insertChunks(chunks: AgentChunkInput[]): Promise<void> {
    await insertChunks(this.pool, chunks);
  }

  async searchThreads(agentId: string, query: string, limit?: number): Promise<AgentSearchHit[]> {
    return search(this.pool, { agentId, query, limit });
  }
}
