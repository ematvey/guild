// An agent leaving service: archive and restore, the two-phase delete (a
// grace period, then the purge the sweeper runs), cancelling the agent's
// in-flight runs, and the deletion export.

import { ApiError } from "../../platform/errors.js";
import { withTransaction, type PlatformPool } from "../../platform/db.js";
import type { UserRow } from "../../platform/store/identity.js";
import type { Agent, AgentStatus, AgentThread } from "../types.js";
import type { AgentCatalog } from "./catalog.js";
import type { AgentRunStore } from "./runs.js";
import { MAX_THREAD_PAGE, type AgentThreadStore } from "./threads.js";

const DEFAULT_GRACE_DAYS = 30;

/** An agent in its deletion grace period takes no new turns: its threads
 *  stay readable (and restorable with the agent) but refuse writes. */
export function refuseDeletingAgent(agent: { status: AgentStatus }): void {
  if (agent.status === "deleting" || agent.status === "deleted") {
    throw ApiError.conflict("agent_deleting", "this agent is being deleted; its threads are read-only");
  }
}

export class AgentLifecycleStore {
  constructor(
    private readonly pool: PlatformPool,
    private readonly catalog: Pick<AgentCatalog, "requireAccess" | "fetchInOrg">,
    private readonly threads: Pick<AgentThreadStore, "listThreads">,
    private readonly runs: Pick<AgentRunStore, "listRoutines" | "listRuns">,
  ) {}

  async archive(user: UserRow, agentId: string): Promise<Agent> {
    const { agent } = await this.catalog.requireAccess(user, agentId, "manage");
    if (agent.is_personal) throw ApiError.badRequest("the personal agent cannot be archived");
    await this.pool.query("UPDATE agents SET status = 'archived', updated_at = now() WHERE org_id = $1 AND id = $2", [
      agent.org_id,
      agentId,
    ]);
    return this.catalog.fetchInOrg(agent.org_id, agentId);
  }

  /** Brings an archived agent, or one in the deletion grace period, back
   *  to active. */
  async restore(user: UserRow, agentId: string): Promise<Agent> {
    const { agent } = await this.catalog.requireAccess(user, agentId, "manage");
    if (agent.status !== "archived" && agent.status !== "deleting") {
      throw ApiError.badRequest("only an archived or deleting agent can be restored");
    }
    await this.pool.query(
      `UPDATE agents SET status = 'active', deleted_at = NULL, purge_after = NULL, updated_at = now()
       WHERE org_id = $1 AND id = $2 AND status IN ('archived', 'deleting')`,
      [agent.org_id, agentId],
    );
    return this.catalog.fetchInOrg(agent.org_id, agentId);
  }

  /** Cancels every queued or running run of the agent, in all its threads,
   *  and returns the chats those runs were driving so the caller can stop
   *  their turns. Archive and delete call it: an agent leaving service
   *  stops its work. */
  async cancelAgentRuns(agentId: string): Promise<string[]> {
    const res = await this.pool.query<{ chat_id: string }>(
      `WITH cancelled AS (
         UPDATE agent_runs r SET status = 'cancelled', finished_at = now()
         FROM agent_threads t
         WHERE t.id = r.thread_id AND t.agent_id = $1 AND r.status IN ('queued', 'running')
         RETURNING t.chat_id
       )
       SELECT DISTINCT chat_id FROM cancelled`,
      [agentId],
    );
    return res.rows.map((row) => row.chat_id);
  }

  /** Phase one of deletion: hide the agent and start the org grace period.
   *  Rows stay until purge. */
  async markDeleted(user: UserRow, agentId: string): Promise<Agent> {
    const { agent } = await this.catalog.requireAccess(user, agentId, "manage");
    if (agent.is_personal) throw ApiError.badRequest("the personal agent cannot be deleted");
    const days = await this.graceDays(agent.org_id);
    await this.pool.query(
      `UPDATE agents
       SET status = 'deleting', deleted_at = now(), purge_after = now() + ($3::int * interval '1 day'), updated_at = now()
       WHERE org_id = $1 AND id = $2`,
      [agent.org_id, agentId, days],
    );
    return this.catalog.fetchInOrg(agent.org_id, agentId);
  }

  /** Phase two: hard-delete the agent row and its thread chats; grants,
   *  threads, runs, chunks and notices cascade. The caller removes the
   *  workspace directory. */
  async purge(user: UserRow, agentId: string): Promise<void> {
    const { agent } = await this.catalog.requireAccess(user, agentId, "manage");
    await this.purgeById(agent.org_id, agentId);
  }

  /** Phase two without an access check: the deletion sweeper and the
   *  owner-initiated purge route both land here. */
  async purgeById(orgId: string, agentId: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      const chats = await client.query<{ chat_id: string }>("SELECT chat_id FROM agent_threads WHERE agent_id = $1", [
        agentId,
      ]);
      await client.query("DELETE FROM agents WHERE org_id = $1 AND id = $2", [orgId, agentId]);
      for (const row of chats.rows) {
        await client.query("DELETE FROM chats WHERE id = $1", [row.chat_id]);
      }
    });
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
    const agent = await this.catalog.fetchInOrg(orgId, agentId);
    const threads: AgentThread[] = [];
    let cursor: string | null = null;
    do {
      const page = await this.threads.listThreads(agentId, agent.owner_user_id, {
        types: ["user", "subagent", "routine"],
        archived: null,
        deleted: null,
        limit: MAX_THREAD_PAGE,
        cursor,
      });
      threads.push(...page.threads);
      cursor = page.next_cursor;
    } while (cursor !== null);
    const [routines, runs] = await Promise.all([this.runs.listRoutines(agentId), this.runs.listRuns(agentId, { limit: 200 })]);
    return { exported_at: new Date().toISOString(), agent, threads, routines, runs };
  }

  /** Reads the org's configured grace period when the optional
   *  agent_settings table exists; otherwise the 30-day default. */
  private async graceDays(orgId: string): Promise<number> {
    const present = await this.pool.query<{ present: boolean }>(
      "SELECT to_regclass('public.agent_settings') IS NOT NULL AS present",
    );
    if (!present.rows[0]?.present) return DEFAULT_GRACE_DAYS;
    const row = await this.pool.query<Record<string, unknown>>("SELECT * FROM agent_settings WHERE org_id = $1", [orgId]);
    const raw = row.rows[0]?.grace_days ?? row.rows[0]?.deletion_grace_days;
    const days = Number(raw);
    return Number.isFinite(days) && days > 0 ? days : DEFAULT_GRACE_DAYS;
  }
}
