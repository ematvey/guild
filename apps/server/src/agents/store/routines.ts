// Routine and occurrence rows (agent_routines, agent_routine_occurrences):
// the definition reads and writes and the idempotent occurrence insert.
// Validation and schedule math live in agents/routines.ts.

import type { PlatformPool } from "../../platform/db.js";
import { pgTimestampToRfc3339, utcText, uuidv7 } from "../../platform/time.js";
import type {
  AgentRoutine,
  AgentRoutineDelivery,
  AgentRoutineKind,
  AgentRoutineOccurrence,
  AgentRoutineOccurrenceStatus,
} from "../types.js";

const ROUTINE_COLUMNS = `r.id, r.agent_id, r.created_by_user_id, r.name, r.kind, r.schedule, r.timezone,
  ${utcText("r.run_at")} AS run_at, r.prompt, r.context, r.delivery, r.enabled,
  ${utcText("r.next_run_at")} AS next_run_at,
  ${utcText("r.created_at")} AS created_at, ${utcText("r.updated_at")} AS updated_at`;

export const OCCURRENCE_COLUMNS = `o.id, o.routine_id, ${utcText("o.scheduled_for")} AS scheduled_for,
  o.run_id, o.status, o.attempts, o.last_error`;

export function toRoutine(row: Record<string, unknown>): AgentRoutine {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    created_by_user_id: (row.created_by_user_id as string | null) ?? null,
    name: row.name as string,
    kind: row.kind as AgentRoutineKind,
    schedule: (row.schedule as string | null) ?? null,
    timezone: row.timezone as string,
    run_at: row.run_at === null || row.run_at === undefined ? null : pgTimestampToRfc3339(row.run_at as string),
    prompt: row.prompt as string,
    context: "isolated",
    delivery: row.delivery === "new_chat" ? "new_chat" : "thread",
    enabled: Boolean(row.enabled),
    next_run_at:
      row.next_run_at === null || row.next_run_at === undefined
        ? null
        : pgTimestampToRfc3339(row.next_run_at as string),
    created_at: pgTimestampToRfc3339(row.created_at as string),
    updated_at: pgTimestampToRfc3339(row.updated_at as string),
  };
}

export function toOccurrence(row: Record<string, unknown>): AgentRoutineOccurrence {
  return {
    id: row.id as string,
    routine_id: row.routine_id as string,
    scheduled_for: pgTimestampToRfc3339(row.scheduled_for as string),
    run_id: (row.run_id as string | null) ?? null,
    status: row.status as AgentRoutineOccurrenceStatus,
    attempts: Number(row.attempts),
    last_error: (row.last_error as string | null) ?? null,
  };
}

/** A routine's validated fields as written. */
export interface RoutineFields {
  name: string;
  kind: AgentRoutineKind;
  schedule: string | null;
  timezone: string;
  run_at: string | null;
  prompt: string;
  delivery: AgentRoutineDelivery;
  enabled: boolean;
  next_run_at: string | null;
}

export async function listRoutines(pool: PlatformPool, agentId: string): Promise<AgentRoutine[]> {
  const res = await pool.query<Record<string, unknown>>(
    `SELECT ${ROUTINE_COLUMNS} FROM agent_routines r
     WHERE r.agent_id = $1 ORDER BY r.created_at DESC, r.id DESC`,
    [agentId],
  );
  return res.rows.map(toRoutine);
}

/** One routine of an agent, or null. */
export async function selectRoutine(
  pool: PlatformPool,
  agentId: string,
  routineId: string,
): Promise<AgentRoutine | null> {
  const res = await pool.query<Record<string, unknown>>(
    `SELECT ${ROUTINE_COLUMNS} FROM agent_routines r
     WHERE r.agent_id = $1 AND r.id = $2`,
    [agentId, routineId],
  );
  const row = res.rows[0];
  return row === undefined ? null : toRoutine(row);
}

export async function insertRoutine(
  pool: PlatformPool,
  agentId: string,
  fields: RoutineFields & { created_by_user_id: string },
): Promise<AgentRoutine> {
  const res = await pool.query<Record<string, unknown>>(
    `WITH r AS (
       INSERT INTO agent_routines
         (id, agent_id, created_by_user_id, name, kind, schedule, timezone, run_at, prompt, context, enabled, next_run_at,
          delivery)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::timestamptz, $9, 'isolated', $10, $11::timestamptz, $12)
       RETURNING *)
     SELECT ${ROUTINE_COLUMNS} FROM r`,
    [
      uuidv7(),
      agentId,
      fields.created_by_user_id,
      fields.name,
      fields.kind,
      fields.schedule,
      fields.timezone,
      fields.run_at,
      fields.prompt,
      fields.enabled,
      fields.next_run_at,
      fields.delivery,
    ],
  );
  return toRoutine(res.rows[0]!);
}

/** Rewrites one routine's fields; null when the agent has no such routine. */
export async function writeRoutine(
  pool: PlatformPool,
  agentId: string,
  routineId: string,
  fields: RoutineFields,
): Promise<AgentRoutine | null> {
  const res = await pool.query<Record<string, unknown>>(
    `WITH r AS (
       UPDATE agent_routines
       SET name = $3, kind = $4, schedule = $5, timezone = $6, run_at = $7::timestamptz,
           prompt = $8, enabled = $9, next_run_at = $10::timestamptz, delivery = $11, updated_at = now()
       WHERE agent_id = $1 AND id = $2
       RETURNING *)
     SELECT ${ROUTINE_COLUMNS} FROM r`,
    [
      agentId,
      routineId,
      fields.name,
      fields.kind,
      fields.schedule,
      fields.timezone,
      fields.run_at,
      fields.prompt,
      fields.enabled,
      fields.next_run_at,
      fields.delivery,
    ],
  );
  const row = res.rows[0];
  return row === undefined ? null : toRoutine(row);
}

/** Deletes one routine; false when the agent has no such routine. */
export async function deleteRoutineRow(pool: PlatformPool, agentId: string, routineId: string): Promise<boolean> {
  const res = await pool.query("DELETE FROM agent_routines WHERE agent_id = $1 AND id = $2", [agentId, routineId]);
  return res.rowCount !== 0;
}

/** Drops the routine's pending occurrences. */
export async function deletePendingOccurrences(pool: PlatformPool, routineId: string): Promise<void> {
  await pool.query(`DELETE FROM agent_routine_occurrences WHERE routine_id = $1 AND status = 'pending'`, [routineId]);
}

/** Inserts one pending occurrence at `scheduledFor` (ISO). `(routine_id,
 *  scheduled_for)` is the idempotency key; a repeated insert returns the
 *  existing row. */
export async function insertOccurrence(
  pool: PlatformPool,
  routineId: string,
  scheduledFor: string,
): Promise<AgentRoutineOccurrence> {
  const inserted = await pool.query<Record<string, unknown>>(
    `WITH o AS (
       INSERT INTO agent_routine_occurrences (id, routine_id, scheduled_for, status)
       VALUES ($1, $2, $3::timestamptz, 'pending')
       ON CONFLICT (routine_id, scheduled_for) DO NOTHING
       RETURNING *)
     SELECT ${OCCURRENCE_COLUMNS} FROM o`,
    [uuidv7(), routineId, scheduledFor],
  );
  if (inserted.rows[0] !== undefined) return toOccurrence(inserted.rows[0]);
  const existing = await pool.query<Record<string, unknown>>(
    `SELECT ${OCCURRENCE_COLUMNS} FROM agent_routine_occurrences o
     WHERE o.routine_id = $1 AND o.scheduled_for = $2::timestamptz`,
    [routineId, scheduledFor],
  );
  return toOccurrence(existing.rows[0]!);
}

export async function listOccurrences(
  pool: PlatformPool,
  routineId: string,
  limit = 50,
): Promise<AgentRoutineOccurrence[]> {
  const capped = Math.max(1, Math.min(200, limit));
  const res = await pool.query<Record<string, unknown>>(
    `SELECT ${OCCURRENCE_COLUMNS} FROM agent_routine_occurrences o
     WHERE o.routine_id = $1
     ORDER BY o.scheduled_for DESC, o.id DESC LIMIT $2`,
    [routineId, capped],
  );
  return res.rows.map(toOccurrence);
}

export async function countPendingReminders(pool: PlatformPool, agentId: string): Promise<number> {
  const res = await pool.query<{ count: number }>(
    `SELECT count(*)::int AS count
     FROM agent_routine_occurrences o
     JOIN agent_routines r ON r.id = o.routine_id
     WHERE r.agent_id = $1 AND r.kind = 'once' AND r.enabled
       AND o.status IN ('pending', 'claimed')`,
    [agentId],
  );
  return Number(res.rows[0]?.count ?? 0);
}
