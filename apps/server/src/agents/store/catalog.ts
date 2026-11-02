// The agent rows: create (with the default thread and its chat), the
// personal agent, visibility-filtered reads, configuration updates and team
// grants, and the authorization check every agent route and tool runs.

import { ApiError } from "../../platform/errors.js";
import { withTransaction, type PlatformPool } from "../../platform/db.js";
import { jsonbText } from "../../platform/domain/text.js";
import { isUuid, uuidv7 } from "../../platform/time.js";
import type { ChatStore } from "../../platform/store/chats.js";
import type { UserRow } from "../../platform/store/identity.js";
import type { Agent, AgentAccess, AgentStatus, AgentToolRef, AgentToolsMode, AgentVisibility } from "../types.js";
import { DEFAULT_AGENT_TOOLS, GRANT_ROLE } from "../types.js";
import { visiblePredicate, type AgentGrants } from "./access.js";
import { AGENT_COLUMNS, toAgent } from "./rows.js";

export interface CreateAgentInput {
  tools_mode?: AgentToolsMode;
  name: string;
  description?: string;
  model: string;
  tools?: AgentToolRef[];
  visibility?: AgentVisibility;
  resources?: Record<string, unknown>;
  team_ids?: string[];
}

export interface UpdateAgentInput {
  tools_mode?: AgentToolsMode;
  name?: string;
  description?: string;
  model?: string;
  tools?: AgentToolRef[];
  visibility?: AgentVisibility;
  resources?: Record<string, unknown>;
  team_ids?: string[];
}

/** Which statuses a list returns: active only by default; `includeArchived`
 *  adds archived and deleting rows; `status` names one. */
export interface AgentListOptions {
  includeArchived?: boolean;
  status?: AgentStatus;
}

/** Default per-agent sandbox budget recorded with every new agent. */
export const DEFAULT_AGENT_RESOURCES = {
  vcpu: 1,
  memory_mb: 2048,
  pids: 256,
  workspace_gib: 50,
} as const;

/** The status clause of a list, binding `options.status` into `params`. */
function statusClause(options: AgentListOptions, params: unknown[]): string {
  if (options.status !== undefined) {
    params.push(options.status);
    return `a.status = $${params.length}`;
  }
  return options.includeArchived === true ? "a.status IN ('active', 'archived', 'deleting')" : "a.status = 'active'";
}

/** The order every agent list returns: newest first. */
const LIST_ORDER = "ORDER BY a.created_at DESC, a.id DESC";

export class AgentCatalog {
  constructor(
    private readonly pool: PlatformPool,
    private readonly chats: Pick<ChatStore, "createChatOn">,
    private readonly agentGrants: AgentGrants,
    /** Seeds a new agent's workspace config files; absent: none seeded. */
    private readonly seedFiles?: (agent: { id: string; org_id: string }) => Promise<unknown>,
  ) {}

  /** Seeds the workspace config files for a new agent. Best-effort: a
   *  missing volume or a permission error must not fail the create. */
  private async seedWorkspace(agent: { id: string; org_id: string; name: string }): Promise<void> {
    if (this.seedFiles === undefined) return;
    try {
      await this.seedFiles(agent);
    } catch {
      // The next turn seeds it again through the runtime path.
    }
  }

  /** Creates the agent, its default thread and that thread's chat journal
   *  row in one transaction. The owner is the caller. */
  async create(user: UserRow, input: CreateAgentInput): Promise<Agent> {
    const id = uuidv7();
    try {
      await withTransaction(this.pool, async (client) => {
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
            jsonbText(input.tools ?? DEFAULT_AGENT_TOOLS),
            input.tools_mode ?? "selected",
            input.visibility ?? "private",
            jsonbText(
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
          `INSERT INTO agent_threads (id, agent_id, user_id, chat_id, title, title_locked, type, is_default)
           VALUES ($1, $2, $3, $4, 'Main thread', false, 'user', true)`,
          [uuidv7(), id, user.id, chat.id],
        );
      });
    } catch (error) {
      if ((error as { code?: string }).code === "23505") {
        throw ApiError.conflict("name_taken", "you already have an agent with this name");
      }
      throw error;
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
        [uuidv7(), orgId, userId, model, jsonbText(DEFAULT_AGENT_TOOLS), jsonbText(DEFAULT_AGENT_RESOURCES)],
      );
    } catch (error) {
      if ((error as { code?: string }).code !== "23505") throw error;
    }
    const created = await find();
    if (created !== null) await this.seedWorkspace(created);
    return created;
  }

  /** Visibility-filtered list, newest first. */
  async list(user: UserRow, options: AgentListOptions = {}): Promise<Agent[]> {
    const params: unknown[] = [user.org_id, user.role === "admin", user.id];
    const where = `${visiblePredicate("a")} AND ${statusClause(options, params)}`;
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${AGENT_COLUMNS} FROM agents a WHERE ${where} ${LIST_ORDER}`,
      params,
    );
    return res.rows.map(toAgent);
  }

  /** Every agent of the org, unfiltered by viewer, in the list's order: the
   *  member socket narrows it per member with `AgentGrants.visibleAgentIds`. */
  async listForOrg(orgId: string, options: AgentListOptions = {}): Promise<Agent[]> {
    const params: unknown[] = [orgId];
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${AGENT_COLUMNS} FROM agents a WHERE a.org_id = $1 AND ${statusClause(options, params)} ${LIST_ORDER}`,
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

  /** The agents a reference names among those the user can see, in any
   *  status: the one with that id, or every agent with that name (names
   *  are unique per owner, not per org). Oldest first. */
  async findVisible(user: UserRow, reference: string): Promise<Agent[]> {
    const match = isUuid(reference) ? "a.id = $4" : "lower(a.name) = lower($4)";
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${AGENT_COLUMNS} FROM agents a
       WHERE ${match} AND ${visiblePredicate("a")}
       ORDER BY a.created_at ASC, a.id ASC`,
      [user.org_id, user.role === "admin", user.id, reference],
    );
    return res.rows.map(toAgent);
  }

  /** The caller's grant role and capability flags for one agent. */
  access(user: UserRow, agent: Agent): Promise<AgentAccess> {
    return this.agentGrants.access(user, agent);
  }

  /** Loads the agent and enforces can_use (read/chat) or can_manage
   *  (configuration, lifecycle). */
  async requireAccess(
    user: UserRow,
    agentId: string,
    mode: "use" | "manage",
  ): Promise<{ agent: Agent; access: AgentAccess }> {
    const agent = await this.get(user, agentId);
    const access = await this.access(user, agent);
    if (mode === "manage" ? !access.can_manage : !access.can_use) {
      throw ApiError.forbidden(mode === "manage" ? "you cannot manage this agent" : "you cannot use this agent");
    }
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
    if (patch.tools !== undefined) add("tools", jsonbText(patch.tools), "::jsonb");
    if (patch.visibility !== undefined) {
      if (agent.is_personal && patch.visibility !== "private") {
        throw ApiError.badRequest("the personal agent is always private");
      }
      add("visibility", patch.visibility);
    }
    if (patch.resources !== undefined) add("resources", jsonbText(patch.resources), "::jsonb");
    if (sets.length === 0 && patch.team_ids === undefined) return agent;
    // The row and its team grants change together or not at all.
    await withTransaction(this.pool, async (client) => {
      if (sets.length > 0) {
        sets.push("updated_at = now()");
        try {
          await client.query(`UPDATE agents SET ${sets.join(", ")} WHERE org_id = $1 AND id = $2`, params);
        } catch (error) {
          if ((error as { code?: string }).code === "23505") {
            throw ApiError.conflict("name_taken", "you already have an agent with this name");
          }
          throw error;
        }
      }
      if (patch.team_ids !== undefined) {
        await this.replaceTeamGrants(client, agent.org_id, agentId, patch.team_ids);
      }
    });
    return this.fetchInOrg(agent.org_id, agentId);
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
      const valid = await db.query("SELECT id FROM teams WHERE org_id = $1 AND id = ANY($2::uuid[])", [orgId, unique]);
      if (valid.rowCount !== unique.length) throw ApiError.badRequest("unknown team");
    }
    await db.query("DELETE FROM agent_team_grants WHERE agent_id = $1", [agentId]);
    for (const teamId of unique) {
      await db.query(
        `INSERT INTO agent_team_grants (agent_id, team_id, role) VALUES ($1, $2, $3)
         ON CONFLICT (agent_id, team_id) DO NOTHING`,
        [agentId, teamId, GRANT_ROLE],
      );
    }
  }

  private async fetchById(orgId: string, agentId: string): Promise<Agent | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${AGENT_COLUMNS} FROM agents a WHERE a.org_id = $1 AND a.id = $2`,
      [orgId, agentId],
    );
    return res.rows[0] === undefined ? null : toAgent(res.rows[0]);
  }

  /** One agent of the org without a caller check; 404 when missing. */
  async fetchInOrg(orgId: string, agentId: string): Promise<Agent> {
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
}
