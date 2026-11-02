// Routine scheduler: materializes due occurrences, claims them with
// FOR UPDATE SKIP LOCKED, coalesces missed runs, launches an isolated agent
// run per claimed occurrence, and turns terminal run states into retries,
// failure notices and auto-disable. The loop lives in the server process;
// tests start it explicitly.

import { rm } from "node:fs/promises";
import type { Logger } from "pino";
import { withTransaction, type PlatformPool } from "../platform/db.js";
import type { GuildRuntime } from "../harness/runtime.js";
import type { Agent, AgentRoutine, AgentRun } from "./types.js";
import type { AgentStore } from "./store.js";
import type { ThreadStore } from "../platform/store/thread.js";
import { ApiError } from "../platform/errors.js";
import { agentWorkspaceDir } from "./workspace-config.js";
import { IdentityStore, type UserRow } from "../platform/store/identity.js";
import { startThreadRun, ThreadRunRefused, ThreadRunSubmitFailed } from "./thread-run.js";
import { createOccurrence, nextOccurrence, previousOccurrence } from "./routines.js";
import {
  type ClaimedOccurrence,
  claimedOccurrences,
  claimOccurrence,
  completeClaim,
  deleteOtherPending,
  disableRoutine,
  dueRoutines,
  failClaim,
  linkOccurrenceRun,
  lockDuePending,
  recentOccurrenceStatuses,
  releaseExpiredClaim,
  retireOnceRoutine,
  retryClaim,
  setNextRunAt,
  skipOlderPending,
} from "./store/occurrences.js";

export const SCHEDULER_TICK_MS = 15_000;
export const MAX_OCCURRENCE_ATTEMPTS = 3;
/** How long a claim with no linked run belongs to its claimer. */
const CLAIM_LEASE_SECONDS = 120;
export const RETRY_DELAYS_MS = [30_000, 60_000, 300_000] as const;
export const MAX_CONSECUTIVE_FAILURES = 10;

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
    const due = await this.deps.store.lifecycle.dueForPurge();
    for (const row of due) {
      try {
        await this.deps.store.lifecycle.purgeById(row.org_id, row.id);
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
    const due = await dueRoutines(this.deps.pool, now.toISOString());
    for (const routine of due) {
      try {
        if (routine.kind === "once") {
          await createOccurrence(this.deps.pool, routine.id, routine.next_run_at);
          await setNextRunAt(this.deps.pool, routine.id, null);
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
        await setNextRunAt(this.deps.pool, routine.id, cursor.toISOString());
      } catch (error) {
        this.deps.log.warn({ err: error, routineId: routine.id }, "routine materialization failed");
      }
    }
  }

  /** Claims one occurrence per due routine, marking older pending ones
   *  skipped. Rows are locked with SKIP LOCKED so a second process can work
   *  on other routines. */
  async claimDue(now: Date = this.now()): Promise<ClaimedOccurrence[]> {
    const claimed: ClaimedOccurrence[] = [];
    await withTransaction(this.deps.pool, async (client) => {
      const rows = await lockDuePending(client, now.toISOString());
      const groups = new Map<string, ClaimedOccurrence[]>();
      for (const row of rows) {
        const list = groups.get(row.routine_id) ?? [];
        list.push(row);
        groups.set(row.routine_id, list);
      }
      for (const group of groups.values()) {
        const latest = group[0]!;
        if (!retryReady(latest, now)) continue;
        if (group.length > 1) {
          await skipOlderPending(client, latest.routine_id, latest.scheduled_for);
        }
        if (await claimOccurrence(client, latest.id)) {
          claimed.push({ ...latest, attempts: latest.attempts + 1 });
        }
      }
    });
    for (const occurrence of claimed) await this.launch(occurrence, now);
    return claimed;
  }

  /** Settles claimed occurrences whose run reached a terminal status. A
   *  failed run either returns to pending (bounded retries) or becomes a
   *  failed occurrence with an owner notice. A claim with no run returns to
   *  pending only once its lease has passed: before that its claimer may
   *  still be launching it, in this process or another. */
  async reconcileClaimed(): Promise<void> {
    const rows = await claimedOccurrences(this.deps.pool);
    for (const row of rows) {
      if (row.run_id === null || row.run_status === null) {
        await releaseExpiredClaim(this.deps.pool, row.id, CLAIM_LEASE_SECONDS);
        continue;
      }
      if (row.run_status === "succeeded" || row.run_status === "silent" || row.run_status === "skipped") {
        if ((await completeClaim(this.deps.pool, row.id)) && row.kind === "once") {
          await retireOnceRoutine(this.deps.pool, row.routine_id);
        }
        continue;
      }
      if (row.run_status !== "failed") continue;
      const failure = row.run_error ?? "routine run failed";
      if (row.attempts >= MAX_OCCURRENCE_ATTEMPTS) {
        if (await failClaim(this.deps.pool, row.id, failure)) {
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
        await retryClaim(this.deps.pool, row.id, failure);
      }
    }
  }

  private async launch(row: ClaimedOccurrence, now: Date): Promise<void> {
    let runId: string | null = null;
    try {
      const title = `${row.routine_name} — ${row.scheduled_for}`;
      const userId = row.created_by_user_id ?? row.owner_user_id;
      const requester = await routineRequester(this.deps.pool, row.created_by_user_id);
      const thread = await this.deps.store.threads.createThread(row.agent_id, userId, title, "routine");
      await startThreadRun(this.deps, {
        agentId: row.agent_id,
        thread,
        requester,
        content: row.prompt,
        failureCode: "routine_submit_failed",
        run: {
          user_id: userId,
          routine_id: row.routine_id,
          trigger: "routine",
          started_at: now.toISOString(),
          summary: row.routine_name,
        },
        // Link the run first: from here the occurrence settles with the run.
        onRunCreated: async (run) => {
          runId = run.id;
          await linkOccurrenceRun(this.deps.pool, row.id, run.id);
        },
      });
    } catch (error) {
      const message = errorText(error);
      this.deps.log.warn({ err: error, occurrenceId: row.id, routineId: row.routine_id }, "routine launch failed");
      if (runId === null && error instanceof ThreadRunRefused) {
        // A refusal does not pass on retry: the occurrence fails now.
        const failed = await failClaim(this.deps.pool, row.id, message).catch(() => false);
        if (failed) {
          await this.writeNotice(row, "routine_failed", {
            routine_id: row.routine_id,
            routine_name: row.routine_name,
            occurrence_id: row.id,
            run_id: null,
            scheduled_for: row.scheduled_for,
            error: message,
          }).catch(() => {});
        }
      } else if (runId === null) {
        await retryClaim(this.deps.pool, row.id, message).catch(() => {});
      }
    }
  }

  private async maybeDisable(row: ClaimedOccurrence): Promise<void> {
    const statuses = await recentOccurrenceStatuses(this.deps.pool, row.routine_id, MAX_CONSECUTIVE_FAILURES);
    let streak = 0;
    for (const status of statuses) {
      if (status !== "failed") break;
      streak += 1;
    }
    if (streak < MAX_CONSECUTIVE_FAILURES) return;
    if (!(await disableRoutine(this.deps.pool, row.routine_id))) return;
    await this.writeNotice(row, "routine_disabled", {
      routine_id: row.routine_id,
      routine_name: row.routine_name,
      consecutive_failures: streak,
    });
  }

  private async writeNotice(row: ClaimedOccurrence, kind: string, payload: Record<string, unknown>): Promise<void> {
    await this.deps.store.notices
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
    await deleteOtherPending(deps.pool, routine.id, occurrence.id);
  }
  await claimOccurrence(deps.pool, occurrence.id);
  const title = `${routine.name} — ${now.toISOString()}`;
  const userId = routine.created_by_user_id ?? agent.owner_user_id;
  const requester = await routineRequester(deps.pool, routine.created_by_user_id).catch((error: unknown) => {
    if (error instanceof ThreadRunRefused) throw refusalError(error);
    throw error;
  });
  const thread = await deps.store.threads.createThread(agent.id, userId, title, "routine");
  try {
    const { run } = await startThreadRun(deps, {
      agentId: agent.id,
      thread,
      requester,
      content: routine.prompt,
      failureCode: "routine_submit_failed",
      run: {
        user_id: userId,
        routine_id: routine.id,
        trigger: "manual",
        started_at: now.toISOString(),
        summary: routine.name,
      },
      onRunCreated: async (run) => {
        await linkOccurrenceRun(deps.pool, occurrence.id, run.id);
      },
    });
    return run;
  } catch (error) {
    if (error instanceof ThreadRunRefused) throw refusalError(error);
    throw error instanceof ThreadRunSubmitFailed ? (error.cause ?? error) : error;
  }
}

/** The user a routine runs for: its creator, who must still be able to use
 *  the agent. A routine with no recorded creator runs as the agent's owner,
 *  whose access the agent itself implies. A creator who no longer exists
 *  is refused like one who lost access. */
async function routineRequester(pool: PlatformPool, creatorId: string | null): Promise<UserRow | undefined> {
  if (creatorId === null) return undefined;
  try {
    return await new IdentityStore(pool).getUser(creatorId);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) {
      throw new ThreadRunRefused("forbidden", "the routine's creator no longer exists");
    }
    throw error;
  }
}

function refusalError(error: ThreadRunRefused): ApiError {
  return error.code === "forbidden" ? ApiError.forbidden(error.message) : ApiError.conflict(error.code, error.message);
}
