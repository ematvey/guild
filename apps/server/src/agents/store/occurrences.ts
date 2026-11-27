// The scheduler's occurrence rows: due routines, the SKIP LOCKED claim,
// the settle transitions of a claimed occurrence, and the routine updates a
// settle or a manual run makes. Every transition is guarded by status so a
// second process racing the same row writes nothing.

import type { PlatformPool, PoolClient } from "../../platform/db.js";
import { utcText } from "../../platform/time.js";
import type { AgentRoutineKind } from "../types.js";

type Db = PlatformPool | PoolClient;

export interface DueRoutine {
  id: string;
  agent_id: string;
}

/** An occurrence with its routine, agent and linked run. */
export interface ClaimedOccurrence {
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

const OCCURRENCE_SELECT = `SELECT o.id, o.routine_id, r.agent_id, a.org_id, a.owner_user_id, r.created_by_user_id, a.model,
                r.name AS routine_name, r.prompt, r.kind,
                ${utcText("o.scheduled_for")} AS scheduled_for, o.attempts, o.run_id,
                run.status AS run_status, run.error_message AS run_error,
                ${utcText("run.finished_at")} AS run_finished_at
         FROM agent_routine_occurrences o
         JOIN agent_routines r ON r.id = o.routine_id
         JOIN agents a ON a.id = r.agent_id
         LEFT JOIN agent_runs run ON run.id = o.run_id`;

/** Enabled routines of active agents whose next_run_at is due. */
export async function dueRoutines(pool: PlatformPool, now: string): Promise<DueRoutine[]> {
  const res = await pool.query<DueRoutine>(
    `SELECT r.id, r.agent_id
     FROM agent_routines r
     JOIN agents a ON a.id = r.agent_id
     WHERE r.enabled AND r.next_run_at IS NOT NULL AND r.next_run_at <= $1::timestamptz
       AND a.status = 'active'`,
    [now],
  );
  return res.rows;
}

/** Sets the routine's next_run_at (null: nothing scheduled). */
export async function setNextRunAt(pool: PoolClient, routineId: string, nextRunAt: string | null): Promise<void> {
  if (nextRunAt === null) {
    await pool.query("UPDATE agent_routines SET next_run_at = NULL, updated_at = now() WHERE id = $1", [routineId]);
    return;
  }
  await pool.query("UPDATE agent_routines SET next_run_at = $2::timestamptz, updated_at = now() WHERE id = $1", [
    routineId,
    nextRunAt,
  ]);
}

/** Locks every due pending occurrence of an enabled routine on an active
 *  agent (SKIP LOCKED), grouped by routine with the latest first. Runs
 *  inside the caller's transaction. */
export async function lockDuePending(client: PoolClient, now: string): Promise<ClaimedOccurrence[]> {
  const res = await client.query<ClaimedOccurrence>(
    `${OCCURRENCE_SELECT}
         WHERE o.status = 'pending' AND o.scheduled_for <= $1::timestamptz
           AND r.enabled AND a.status = 'active'
         ORDER BY o.routine_id, o.scheduled_for DESC, o.id DESC
         FOR UPDATE OF o SKIP LOCKED`,
    [now],
  );
  return res.rows;
}

/** Marks the routine's pending occurrences before `scheduledFor` skipped. */
export async function skipOlderPending(db: Db, routineId: string, scheduledFor: string): Promise<void> {
  await db.query(
    `UPDATE agent_routine_occurrences SET status = 'skipped'
     WHERE routine_id = $1 AND status = 'pending' AND scheduled_for < $2::timestamptz`,
    [routineId, scheduledFor],
  );
}

/** Claims one pending occurrence; false when it is no longer pending. */
export async function claimOccurrence(db: Db, occurrenceId: string): Promise<boolean> {
  const updated = await db.query(
    `UPDATE agent_routine_occurrences
     SET status = 'claimed', attempts = attempts + 1, claimed_at = now()
     WHERE id = $1 AND status = 'pending'`,
    [occurrenceId],
  );
  return (updated.rowCount ?? 0) > 0;
}

/** Every claimed occurrence with its linked run's state. */
export async function claimedOccurrences(pool: PlatformPool): Promise<ClaimedOccurrence[]> {
  const res = await pool.query<ClaimedOccurrence>(`${OCCURRENCE_SELECT}
       WHERE o.status = 'claimed'`);
  return res.rows;
}

/** Returns a claim with no run to pending once its lease has passed. */
export async function releaseExpiredClaim(
  pool: PlatformPool,
  occurrenceId: string,
  leaseSeconds: number,
): Promise<void> {
  await pool.query(
    `UPDATE agent_routine_occurrences SET status = 'pending'
     WHERE id = $1 AND status = 'claimed'
       AND (claimed_at IS NULL OR claimed_at < now() - $2::interval)`,
    [occurrenceId, `${leaseSeconds} seconds`],
  );
}

/** Settles a claimed occurrence done; false when it was not claimed. */
export async function completeClaim(pool: PlatformPool, occurrenceId: string): Promise<boolean> {
  const updated = await pool.query(
    `UPDATE agent_routine_occurrences SET status = 'done', last_error = NULL
     WHERE id = $1 AND status = 'claimed'`,
    [occurrenceId],
  );
  return (updated.rowCount ?? 0) > 0;
}

/** Settles a claimed occurrence failed; false when it was not claimed. */
export async function failClaim(pool: PlatformPool, occurrenceId: string, error: string): Promise<boolean> {
  const updated = await pool.query(
    `UPDATE agent_routine_occurrences SET status = 'failed', last_error = $2
     WHERE id = $1 AND status = 'claimed'`,
    [occurrenceId, error],
  );
  return (updated.rowCount ?? 0) > 0;
}

/** Returns a claimed occurrence to pending with its error, for a retry. */
export async function retryClaim(pool: PlatformPool, occurrenceId: string, error: string): Promise<void> {
  await pool.query(
    `UPDATE agent_routine_occurrences SET status = 'pending', last_error = $2
     WHERE id = $1 AND status = 'claimed'`,
    [occurrenceId, error],
  );
}

/** A finished one-shot routine: disabled, unscheduled, and its pending
 *  occurrences dropped. */
export async function retireOnceRoutine(pool: PlatformPool, routineId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_routines SET enabled = false, next_run_at = NULL, updated_at = now()
     WHERE id = $1`,
    [routineId],
  );
  await pool.query(`DELETE FROM agent_routine_occurrences WHERE routine_id = $1 AND status = 'pending'`, [routineId]);
}

/** Links the occurrence to the run that executes it. */
export async function linkOccurrenceRun(pool: PlatformPool, occurrenceId: string, runId: string): Promise<void> {
  await pool.query("UPDATE agent_routine_occurrences SET run_id = $2 WHERE id = $1", [occurrenceId, runId]);
}

/** The routine's latest `limit` occurrence statuses, newest first. */
export async function recentOccurrenceStatuses(
  pool: PlatformPool,
  routineId: string,
  limit: number,
): Promise<string[]> {
  const res = await pool.query<{ status: string }>(
    `SELECT status FROM agent_routine_occurrences
     WHERE routine_id = $1 ORDER BY scheduled_for DESC, id DESC LIMIT $2`,
    [routineId, limit],
  );
  return res.rows.map((row) => row.status);
}

/** Disables an enabled routine; false when it was already disabled. */
export async function disableRoutine(pool: PlatformPool, routineId: string): Promise<boolean> {
  const disabled = await pool.query(
    `UPDATE agent_routines SET enabled = false, next_run_at = NULL, updated_at = now()
     WHERE id = $1 AND enabled
     RETURNING id`,
    [routineId],
  );
  return (disabled.rowCount ?? 0) > 0;
}

/** Drops the routine's pending occurrences other than `keepId`. */
export async function deleteOtherPending(pool: PlatformPool, routineId: string, keepId: string): Promise<void> {
  await pool.query(
    `DELETE FROM agent_routine_occurrences
     WHERE routine_id = $1 AND id <> $2 AND status = 'pending'`,
    [routineId, keepId],
  );
}
