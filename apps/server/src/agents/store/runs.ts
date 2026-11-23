// Agent runs: create and update (mirrored into the trace store, with the
// subagent-tree NOTIFY on a status move), the run lookups a turn resolves
// itself by, the run's derived steps, the org activity log, and the
// routine list with each routine's last run.

import { ApiError } from "../../platform/errors.js";
import type { PlatformPool } from "../../platform/db.js";
import { uuidv7 } from "../../platform/time.js";
import type { TraceStore } from "../../platform/trace.js";
import type { UserRow } from "../../platform/store/identity.js";
import type {
  AgentActivityEntry,
  AgentRoutine,
  AgentRun,
  AgentRunStatus,
  AgentRunStep,
  AgentTrigger,
} from "../types.js";
import { listRoutines } from "./routines.js";
import { notifySubagentTree } from "./tree.js";
import { visiblePredicate } from "./access.js";
import { RUN_COLUMNS, toRun } from "./rows.js";

export interface RunFilters {
  userId?: string;
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

export interface CreateRunInput {
  /** Stable identity for a replay-safe coordination action. */
  id?: string;
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

/** The trace context of the chat's open run (the tool hook's spans). */
export interface RunTraceContext {
  run_id: string;
  org_id: string;
  user_id: string | null;
  session_id: string;
  agent_id: string;
  agent_name: string;
}

const UPDATE_COLUMNS: readonly (keyof UpdateRunInput)[] = [
  "thread_id",
  "status",
  "summary",
  "error_code",
  "error_message",
  "error_step",
  "tokens",
  "started_at",
  "finished_at",
];

/** Clamps a page size to 1..200 (default 50). */
function pageLimit(limit: number | undefined): number {
  return Math.max(1, Math.min(200, limit ?? 50));
}

export class AgentRunStore {
  constructor(
    private readonly pool: PlatformPool,
    /** Mirrors run lifecycle rows into ClickHouse (agent_traces). */
    private readonly trace?: TraceStore,
  ) {}

  async listRuns(agentId: string, filters: RunFilters = {}): Promise<AgentRun[]> {
    const params: unknown[] = [agentId];
    let where =
      "r.agent_id = $1 AND NOT EXISTS (SELECT 1 FROM agent_threads it JOIN chats ic ON ic.id=it.chat_id WHERE it.id=r.thread_id AND ic.internal)";
    if ("userId" in filters && filters.userId !== undefined) {
      params.push(filters.userId);
      where += ` AND r.user_id=$${params.length}`;
    }
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
    params.push(pageLimit(filters.limit));
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
      const res = await this.pool.query<{
        seq: string;
        type: string;
        payload: Record<string, unknown>;
        created_at: Date;
      }>(
        `SELECT e.seq, e.type, e.payload, e.created_at
         FROM agent_threads t JOIN thread_events e ON e.chat_id = t.chat_id
         WHERE t.id = $1 AND e.created_at >= $2::timestamptz
           AND ($3::timestamptz IS NULL OR e.created_at <= $3::timestamptz)
         ORDER BY e.seq ASC LIMIT 200`,
        [run.thread_id, run.started_at ?? run.created_at, run.finished_at],
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
      // The user message that started the run lands just before its start,
      // so the window above does not hold it. Read the trigger separately
      // and put it first: the run detail opens with what the run answered.
      if (!steps.some((step) => step.type === "user_message")) {
        const trigger = await this.pool.query<{
          seq: string;
          payload: Record<string, unknown>;
          created_at: Date;
        }>(
          `SELECT e.seq, e.payload, e.created_at
           FROM agent_threads t JOIN thread_events e ON e.chat_id = t.chat_id
           WHERE t.id = $1 AND e.type = 'user_message' AND e.created_at < $2::timestamptz
           ORDER BY e.seq DESC LIMIT 1`,
          [run.thread_id, run.started_at ?? run.created_at],
        );
        const row = trigger.rows[0];
        if (row !== undefined) {
          const text = typeof row.payload.content === "string" ? row.payload.content : "";
          if (text.trim() !== "") {
            steps.unshift({
              type: "user_message",
              seq: Number(row.seq),
              ts: row.created_at.toISOString(),
              text: text.slice(0, 4_000),
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
      steps.push({ type: "file", ts: (row.finished_at ?? new Date()).toISOString(), paths: row.paths });
    }
    return steps;
  }

  /** The chat's running run: the row of its current pi-durable run. Tools
   *  and model calls inside a run use it to resolve the run they belong to. */
  async runningRunForChat(chatId: string): Promise<AgentRun | null> {
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs r
       JOIN agent_threads t ON t.id = r.thread_id
       WHERE t.chat_id = $1 AND r.status = 'running'
       ORDER BY r.created_at ASC, r.id ASC LIMIT 1`,
      [chatId],
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

  async createRun(input: CreateRunInput): Promise<AgentRun> {
    const res = await this.pool.query<Record<string, unknown>>(
      `WITH r AS (
         INSERT INTO agent_runs
           (id, agent_id, user_id, thread_id, routine_id, parent_run_id, delegate_agent_id, depth, trigger, status, summary, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (id) DO UPDATE SET id=EXCLUDED.id
         RETURNING *)
       SELECT ${RUN_COLUMNS} FROM r`,
      [
        input.id ?? uuidv7(),
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
    if (run.thread_id !== null) await notifySubagentTree(this.pool, run.thread_id);
    return run;
  }

  async updateRun(runId: string, patch: UpdateRunInput): Promise<AgentRun> {
    const sets: string[] = [];
    const params: unknown[] = [runId];
    for (const key of UPDATE_COLUMNS) {
      if (!Object.hasOwn(patch, key)) continue;
      params.push(patch[key]);
      sets.push(`${key} = $${params.length}`);
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
    // A status change moves the running tree of every ancestor chat.
    if (patch.status !== undefined && run.thread_id !== null) {
      await notifySubagentTree(this.pool, run.thread_id);
    }
    return run;
  }

  /** Mirrors one run row into ClickHouse; best-effort and never blocking. */
  private mirrorRun(run: AgentRun): void {
    const trace = this.trace;
    if (trace === undefined) return;
    void this.mirrorContext(run.agent_id, run.thread_id)
      .then((ctx) => {
        if (ctx === null) return;
        return trace.recordTrace({
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

  private async mirrorContext(
    agentId: string,
    threadId: string | null,
  ): Promise<{ org_id: string; agent_name: string; chat_id: string | null } | null> {
    const res = await this.pool.query<{ org_id: string; agent_name: string; chat_id: string | null }>(
      `SELECT a.org_id, a.name AS agent_name, t.chat_id
       FROM agents a LEFT JOIN agent_threads t ON t.id = $2
       LEFT JOIN chats c ON c.id = t.chat_id
       WHERE a.id = $1 AND c.internal IS DISTINCT FROM true`,
      [agentId, threadId],
    );
    return res.rows[0] ?? null;
  }

  /** The chat's running run with the trace context the tool hook needs. */
  async runningRunTraceForChat(chatId: string): Promise<RunTraceContext | null> {
    const res = await this.pool.query<RunTraceContext>(
      `SELECT r.id AS run_id, a.org_id, r.user_id, t.chat_id AS session_id, r.agent_id, a.name AS agent_name
       FROM agent_runs r
       JOIN agent_threads t ON t.id = r.thread_id
       JOIN agents a ON a.id = r.agent_id
       JOIN chats c ON c.id = t.chat_id
       WHERE t.chat_id = $1 AND NOT c.internal AND r.status IN ('queued', 'running')
       ORDER BY r.created_at ASC, r.id ASC LIMIT 1`,
      [chatId],
    );
    return res.rows[0] ?? null;
  }

  /** Org activity log with the agent name. When a viewer is supplied the
   *  same visibility predicate as the agent list applies. */
  async listActivity(orgId: string, filters: ActivityFilters = {}, viewer?: UserRow): Promise<AgentActivityEntry[]> {
    const params: unknown[] = [orgId];
    let where =
      "a.org_id = $1 AND NOT EXISTS (SELECT 1 FROM agent_threads it JOIN chats ic ON ic.id=it.chat_id WHERE it.id=r.thread_id AND ic.internal)";
    if (viewer !== undefined) {
      params.push(viewer.role === "admin", viewer.id);
      where += ` AND ${visiblePredicate("a")} AND ($2 OR r.user_id=$3)`;
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
    params.push(pageLimit(filters.limit), Math.max(0, filters.offset ?? 0));
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
    params.push(pageLimit(filters.limit));
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT ${RUN_COLUMNS} FROM agent_runs r WHERE ${where}
       ORDER BY r.created_at DESC, r.id DESC LIMIT $${params.length}`,
      params,
    );
    return res.rows.map(toRun);
  }

  /** The agent's routines, each with its newest run. */
  async listRoutines(agentId: string): Promise<AgentRoutine[]> {
    const routines = await listRoutines(this.pool, agentId);
    if (routines.length === 0) return routines;
    const res = await this.pool.query<Record<string, unknown>>(
      `SELECT DISTINCT ON (r.routine_id) ${RUN_COLUMNS}
       FROM agent_runs r
       WHERE r.routine_id = ANY($1::uuid[])
       ORDER BY r.routine_id, r.created_at DESC, r.id DESC`,
      [routines.map((routine) => routine.id)],
    );
    const lastByRoutine = new Map(res.rows.map((row) => [row.routine_id as string, toRun(row)]));
    return routines.map((routine) => ({ ...routine, last_run: lastByRoutine.get(routine.id) ?? null }));
  }
}
