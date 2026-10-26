// Routine scheduler: materializes due occurrences, claims them with
// FOR UPDATE SKIP LOCKED, coalesces missed runs, launches an isolated agent
// run per claimed occurrence, and turns terminal run states into retries,
// failure notices and auto-disable. The loop lives in the server process;
// tests start it explicitly.

import { rm } from "node:fs/promises";
import type { Logger } from "pino";
import type { PlatformPool } from "../platform/db.js";
import { uuidv7 } from "../platform/time.js";
import type { GuildRuntime } from "../harness/runtime.js";
import type { Agent, AgentRoutine, AgentRoutineKind, AgentRun } from "./types.js";
import { AgentStore } from "./store.js";
import type { ThreadStore } from "../platform/store/thread.js";
import { userMessageEvent } from "../platform/domain/thread-events.js";
import { agentWorkspaceDir } from "./workspace-config.js";
import { createOccurrence, nextOccurrence, previousOccurrence } from "./routines.js";

export const SCHEDULER_TICK_MS = 15_000;
export const MAX_OCCURRENCE_ATTEMPTS = 3;
export const RETRY_DELAYS_MS = [30_000, 60_000, 300_000] as const;
export const MAX_CONSECUTIVE_FAILURES = 10;

const TS = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

type SchedulerRuntime = Pick<GuildRuntime, "submitTurn">;

export interface AgentSchedulerDeps {
  pool: PlatformPool;
  store: AgentStore;
  threads: ThreadStore;
  runtime: SchedulerRuntime;
  log: Logger;
  enabled?: boolean;
  intervalMs?: number;
  now?: () => Date;
  /** Read-write workspace root; the deletion sweep removes agent dirs. */
  workspaceRoot?: string;
}

interface DueRoutine {
  id: string;
  agent_id: string;
  kind: AgentRoutineKind;
  schedule: string | null;
  timezone: string;
  next_run_at: string;
}

interface ClaimedOccurrence {
  id: string;
  routine_id: string;
  agent_id: string;
  org_id: string;
  owner_user_id: string;
  created_by_user_id: string | null;
  model: string;
  routine_name: string;
  prompt: string;
  kind: AgentRoutineKind;
  scheduled_for: string;
  attempts: number;
  run_id: string | null;
  run_status: string | null;
  run_error: string | null;
  run_finished_at: string | null;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function retryReady(row: ClaimedOccurrence, now: Date): boolean {
  if (row.attempts <= 0 || row.run_status !== "failed" || row.run_finished_at === null) return true;
  const delay = RETRY_DELAYS_MS[Math.min(row.attempts - 1, RETRY_DELAYS_MS.length - 1)]!;
  return new Date(row.run_finished_at).getTime() + delay <= now.getTime();
}

export class AgentScheduler {
  private timer: NodeJS.Timeout | undefined;
  private ticking = false;

  constructor(private readonly deps: AgentSchedulerDeps) {}

  get enabled(): boolean {
    return this.deps.enabled !== false;
  }

  start(): void {
    if (!this.enabled || this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.tick();
    }, this.deps.intervalMs ?? SCHEDULER_TICK_MS);
    this.timer.unref();
    void this.tick();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** One scheduler pass: settle finished runs, materialize due schedules,
   *  then claim and launch. A tick never overlaps itself. */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const now = this.now();
    try {
      await this.reconcileClaimed();
      await this.materializeDue(now);
      await this.claimDue(now);
      await this.purgeDue();
    } catch (error) {
      this.deps.log.warn({ err: error }, "agent scheduler tick failed");
    } finally {
      this.ticking = false;
    }
  }

  /** Phase two of agent deletion: rows past their grace period are purged
   *  and their workspace directories removed. */
  private async purgeDue(): Promise<void> {
    const due = await this.deps.store.dueForPurge();
    for (const row of due) {
      try {
        await this.deps.store.purgeById(row.org_id, row.id);
        if (this.deps.workspaceRoot !== undefined) {
          await rm(agentWorkspaceDir(this.deps.workspaceRoot, row.org_id, row.id), {
            recursive: true,
            force: true,
          });
        }
      } catch (error) {
        this.deps.log.warn({ err: error, agentId: row.id }, "agent purge failed");
      }
    }
  }

  /** Creates occurrence rows for every enabled routine whose next_run_at is
   *  due, then advances next_run_at. A long gap is bounded; if it exceeds
   *  the materialization cap only the latest missed instant is inserted. */
  async materializeDue(now: Date = this.now()): Promise<void> {
    const res = await this.deps.pool.query<DueRoutine>(
      `SELECT r.id, r.agent_id, r.kind, r.schedule, r.timezone,
              ${TS("r.next_run_at")} AS next_run_at
       FROM agent_routines r
       JOIN agents a ON a.id = r.agent_id
       WHERE r.enabled AND r.next_run_at IS NOT NULL AND r.next_run_at <= $1::timestamptz
         AND a.status = 'active'`,
      [now.toISOString()],
    );
    for (const routine of res.rows) {
      try {
        if (routine.kind === "once") {
          await createOccurrence(this.deps.pool, routine.id, routine.next_run_at);
          await this.deps.pool.query(
            "UPDATE agent_routines SET next_run_at = NULL, updated_at = now() WHERE id = $1",
            [routine.id],
          );
          continue;
        }
        if (routine.schedule === null) continue;
        let cursor = new Date(routine.next_run_at);
        const missed: Date[] = [];
        while (cursor.getTime() <= now.getTime() && missed.length < 1_000) {
          missed.push(cursor);
          cursor = nextOccurrence(routine.schedule, routine.timezone, new Date(cursor.getTime() + 1_000));
        }
        if (cursor.getTime() <= now.getTime()) {
          const latest = previousOccurrence(routine.schedule, routine.timezone, now);
          if (latest !== null) await createOccurrence(this.deps.pool, routine.id, latest);
          cursor = nextOccurrence(routine.schedule, routine.timezone, now);
        } else {
          for (const scheduled of missed) {
            await createOccurrence(this.deps.pool, routine.id, scheduled);
          }
        }
        await this.deps.pool.query(
          "UPDATE agent_routines SET next_run_at = $2::timestamptz, updated_at = now() WHERE id = $1",
          [routine.id, cursor.toISOString()],
        );
      } catch (error) {
        this.deps.log.warn({ err: error, routineId: routine.id }, "routine materialization failed");
      }
    }
  }

  /** Claims one occurrence per due routine, marking older pending ones
   *  skipped. Rows are locked with SKIP LOCKED so a second process can work
   *  on other routines. */
  async claimDue(now: Date = this.now()): Promise<ClaimedOccurrence[]> {
    const client = await this.deps.pool.connect();
    let claimed: ClaimedOccurrence[] = [];
    try {
      await client.query("BEGIN");
      const res = await client.query<ClaimedOccurrence>(
        `SELECT o.id, o.routine_id, r.agent_id, a.org_id, a.owner_user_id, r.created_by_user_id, a.model,
                r.name AS routine_name, r.prompt, r.kind,
                ${TS("o.scheduled_for")} AS scheduled_for, o.attempts, o.run_id,
                run.status AS run_status, run.error_message AS run_error,
                ${TS("run.finished_at")} AS run_finished_at
         FROM agent_routine_occurrences o
         JOIN agent_routines r ON r.id = o.routine_id
         JOIN agents a ON a.id = r.agent_id
         LEFT JOIN agent_runs run ON run.id = o.run_id
         WHERE o.status = 'pending' AND o.scheduled_for <= $1::timestamptz
           AND r.enabled AND a.status = 'active'
         ORDER BY o.routine_id, o.scheduled_for DESC, o.id DESC
         FOR UPDATE OF o SKIP LOCKED`,
        [now.toISOString()],
      );
      const groups = new Map<string, ClaimedOccurrence[]>();
      for (const row of res.rows) {
        const list = groups.get(row.routine_id) ?? [];
        list.push(row);
        groups.set(row.routine_id, list);
      }
      for (const group of groups.values()) {
        const latest = group[0]!;
        if (!retryReady(latest, now)) continue;
        if (group.length > 1) {
          await client.query(
            `UPDATE agent_routine_occurrences SET status = 'skipped'
             WHERE routine_id = $1 AND status = 'pending' AND scheduled_for < $2::timestamptz`,
            [latest.routine_id, latest.scheduled_for],
          );
        }
        const updated = await client.query(
          `UPDATE agent_routine_occurrences
           SET status = 'claimed', attempts = attempts + 1
           WHERE id = $1 AND status = 'pending'`,
          [latest.id],
        );
        if ((updated.rowCount ?? 0) > 0) {
          claimed.push({ ...latest, attempts: latest.attempts + 1 });
        }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    } finally {
      client.release();
    }
    for (const occurrence of claimed) await this.launch(occurrence, now);
    return claimed;
  }

  /** Settles claimed occurrences whose run reached a terminal status. A
   *  failed run either returns to pending (bounded retries) or becomes a
   *  failed occurrence with an owner notice. */
  async reconcileClaimed(): Promise<void> {
    const res = await this.deps.pool.query<ClaimedOccurrence>(
      `SELECT o.id, o.routine_id, r.agent_id, a.org_id, a.owner_user_id, r.created_by_user_id, a.model,
              r.name AS routine_name, r.prompt, r.kind,
              ${TS("o.scheduled_for")} AS scheduled_for, o.attempts, o.run_id,
              run.status AS run_status, run.error_message AS run_error,
              ${TS("run.finished_at")} AS run_finished_at
       FROM agent_routine_occurrences o
       JOIN agent_routines r ON r.id = o.routine_id
       JOIN agents a ON a.id = r.agent_id
       LEFT JOIN agent_runs run ON run.id = o.run_id
       WHERE o.status = 'claimed'`,
    );
    for (const row of res.rows) {
      if (row.run_id === null || row.run_status === null) {
        await this.deps.pool.query(
          `UPDATE agent_routine_occurrences SET status = 'pending'
           WHERE id = $1 AND status = 'claimed'`,
          [row.id],
        );
        continue;
      }
      if (row.run_status === "succeeded" || row.run_status === "silent" || row.run_status === "skipped") {
        const updated = await this.deps.pool.query(
          `UPDATE agent_routine_occurrences SET status = 'done', last_error = NULL
           WHERE id = $1 AND status = 'claimed'`,
          [row.id],
        );
        if ((updated.rowCount ?? 0) > 0 && row.kind === "once") {
          await this.deps.pool.query(
            `UPDATE agent_routines SET enabled = false, next_run_at = NULL, updated_at = now()
             WHERE id = $1`,
            [row.routine_id],
          );
          await this.deps.pool.query(
            `DELETE FROM agent_routine_occurrences WHERE routine_id = $1 AND status = 'pending'`,
            [row.routine_id],
          );
        }
        continue;
      }
      if (row.run_status !== "failed") continue;
      const failure = row.run_error ?? "routine run failed";
      if (row.attempts >= MAX_OCCURRENCE_ATTEMPTS) {
        const updated = await this.deps.pool.query(
          `UPDATE agent_routine_occurrences SET status = 'failed', last_error = $2
           WHERE id = $1 AND status = 'claimed'`,
          [row.id, failure],
        );
        if ((updated.rowCount ?? 0) > 0) {
          await this.writeNotice(row, "routine_failed", {
            routine_id: row.routine_id,
            routine_name: row.routine_name,
            occurrence_id: row.id,
            run_id: row.run_id,
            scheduled_for: row.scheduled_for,
            error: failure,
          });
          await this.maybeDisable(row);
        }
      } else {
        await this.deps.pool.query(
          `UPDATE agent_routine_occurrences SET status = 'pending', last_error = $2
           WHERE id = $1 AND status = 'claimed'`,
          [row.id, failure],
        );
      }
    }
  }

  private async launch(row: ClaimedOccurrence, now: Date): Promise<void> {
    let runId: string | null = null;
    try {
      const title = `${row.routine_name} — ${row.scheduled_for}`;
      const userId = row.created_by_user_id ?? row.owner_user_id;
      const thread = await this.deps.store.createThread(row.agent_id, userId, title, "routine");
      const run = await this.deps.store.createRun({
        agent_id: row.agent_id,
        user_id: userId,
        thread_id: thread.id,
        routine_id: row.routine_id,
        trigger: "routine",
        status: "running",
        started_at: now.toISOString(),
        summary: row.routine_name,
      });
      runId = run.id;
      await this.deps.threads.appendEvent(thread.chat_id, userMessageEvent(row.prompt));
      await this.deps.pool.query(
        "UPDATE agent_routine_occurrences SET run_id = $2 WHERE id = $1",
        [row.id, run.id],
      );
      await this.deps.runtime.submitTurn(thread.chat_id, row.org_id, {
        orgId: row.org_id,
        requestId: uuidv7(),
        content: row.prompt,
        images: [],
        model: row.model,
      });
    } catch (error) {
      const message = errorText(error);
      this.deps.log.warn({ err: error, occurrenceId: row.id, routineId: row.routine_id }, "routine launch failed");
      if (runId !== null) {
        await this.deps.store
          .updateRun(runId, {
            status: "failed",
            error_code: "routine_submit_failed",
            error_message: message,
            finished_at: new Date().toISOString(),
          })
          .catch(() => {});
      } else {
        await this.deps.pool
          .query(
            `UPDATE agent_routine_occurrences SET status = 'pending', last_error = $2
             WHERE id = $1 AND status = 'claimed'`,
            [row.id, message],
          )
          .catch(() => {});
      }
    }
  }

  private async maybeDisable(row: ClaimedOccurrence): Promise<void> {
    const res = await this.deps.pool.query<{ status: string }>(
      `SELECT status FROM agent_routine_occurrences
       WHERE routine_id = $1 ORDER BY scheduled_for DESC, id DESC LIMIT $2`,
      [row.routine_id, MAX_CONSECUTIVE_FAILURES],
    );
    let streak = 0;
    for (const occurrence of res.rows) {
      if (occurrence.status !== "failed") break;
      streak += 1;
    }
    if (streak < MAX_CONSECUTIVE_FAILURES) return;
    const disabled = await this.deps.pool.query(
      `UPDATE agent_routines SET enabled = false, next_run_at = NULL, updated_at = now()
       WHERE id = $1 AND enabled
       RETURNING id`,
      [row.routine_id],
    );
    if ((disabled.rowCount ?? 0) === 0) return;
    await this.writeNotice(row, "routine_disabled", {
      routine_id: row.routine_id,
      routine_name: row.routine_name,
      consecutive_failures: streak,
    });
  }

  private async writeNotice(
    row: ClaimedOccurrence,
    kind: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    await this.deps.store
      .createNotice({
        org_id: row.org_id,
        agent_id: row.agent_id,
        user_id: row.owner_user_id,
        kind,
        payload,
      })
      .catch((error) => this.deps.log.warn({ err: error, routineId: row.routine_id }, "routine notice failed"));
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }
}

/** Runs a routine immediately, outside the tick loop. Manual runs are real
 *  occurrences, so they share the hidden thread and run-history shape. */
export async function runRoutineNow(
  deps: Pick<AgentSchedulerDeps, "pool" | "store" | "threads" | "runtime">,
  agent: Agent,
  routine: AgentRoutine,
): Promise<AgentRun> {
  if (agent.status !== "active") throw new Error("agent is not active");
  const now = new Date();
  const occurrence = await createOccurrence(deps.pool, routine.id, now);
  if (routine.kind === "once") {
    await deps.pool.query(
      `DELETE FROM agent_routine_occurrences
       WHERE routine_id = $1 AND id <> $2 AND status = 'pending'`,
      [routine.id, occurrence.id],
    );
  }
  await deps.pool.query(
    `UPDATE agent_routine_occurrences
     SET status = 'claimed', attempts = attempts + 1
     WHERE id = $1 AND status = 'pending'`,
    [occurrence.id],
  );
  const title = `${routine.name} — ${now.toISOString()}`;
  const userId = routine.created_by_user_id ?? agent.owner_user_id;
  const thread = await deps.store.createThread(agent.id, userId, title, "routine");
  const run = await deps.store.createRun({
    agent_id: agent.id,
    user_id: userId,
    thread_id: thread.id,
    routine_id: routine.id,
    trigger: "manual",
    status: "running",
    started_at: now.toISOString(),
    summary: routine.name,
  });
  await deps.pool.query("UPDATE agent_routine_occurrences SET run_id = $2 WHERE id = $1", [occurrence.id, run.id]);
  await deps.threads.appendEvent(thread.chat_id, userMessageEvent(routine.prompt));
  try {
    await deps.runtime.submitTurn(thread.chat_id, agent.org_id, {
      orgId: agent.org_id,
      requestId: uuidv7(),
      content: routine.prompt,
      images: [],
      model: agent.model,
    });
  } catch (error) {
    await deps.store
      .updateRun(run.id, {
        status: "failed",
        error_code: "routine_submit_failed",
        error_message: errorText(error),
        finished_at: new Date().toISOString(),
      })
      .catch(() => {});
    throw error;
  }
  return run;
}
