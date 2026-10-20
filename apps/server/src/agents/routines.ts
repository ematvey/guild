// Agent routines: durable cron/one-shot definitions plus their occurrence
// rows. A routine is owned by one agent; an occurrence is the idempotent
// scheduled instant `(routine_id, scheduled_for)` the scheduler claims.
// Interval sugar is normalized to a five-field cron expression so every
// schedule has one representation in the database.

import { Cron } from "croner";
import { ApiError } from "../platform/errors.js";
import type { PlatformPool } from "../platform/db.js";
import { pgTimestampToRfc3339, uuidv7 } from "../platform/time.js";
import type {
  AgentRoutine,
  AgentRoutineKind,
  AgentRoutineOccurrence,
  AgentRoutineOccurrenceStatus,
} from "./types.js";

export const DEFAULT_ROUTINE_TIMEZONE = "UTC";
export const MIN_INTERVAL_MS = 60_000;
export const MAX_PENDING_REMINDERS = 20;

export interface CreateRoutineInput {
  name: string;
  kind: AgentRoutineKind;
  schedule?: string | null;
  timezone?: string | null;
  run_at?: string | null;
  prompt: string;
  enabled?: boolean;
}

export interface UpdateRoutineInput {
  name?: string;
  kind?: AgentRoutineKind;
  schedule?: string | null;
  timezone?: string | null;
  run_at?: string | null;
  prompt?: string;
  enabled?: boolean;
}

export interface ReminderInput {
  at: string;
  prompt: string;
}

export interface ReminderResult {
  routine_id: string;
  run_at: string;
}

const TS = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const ROUTINE_COLUMNS = `r.id, r.agent_id, r.name, r.kind, r.schedule, r.timezone,
  ${TS("r.run_at")} AS run_at, r.prompt, r.context, r.enabled,
  ${TS("r.next_run_at")} AS next_run_at,
  ${TS("r.created_at")} AS created_at, ${TS("r.updated_at")} AS updated_at`;

const OCCURRENCE_COLUMNS = `o.id, o.routine_id, ${TS("o.scheduled_for")} AS scheduled_for,
  o.run_id, o.status, o.attempts, o.last_error`;

function toRoutine(row: Record<string, unknown>): AgentRoutine {
  return {
    id: row.id as string,
    agent_id: row.agent_id as string,
    name: row.name as string,
    kind: row.kind as AgentRoutineKind,
    schedule: (row.schedule as string | null) ?? null,
    timezone: row.timezone as string,
    run_at: row.run_at === null || row.run_at === undefined ? null : pgTimestampToRfc3339(row.run_at as string),
    prompt: row.prompt as string,
    context: "isolated",
    enabled: Boolean(row.enabled),
    next_run_at:
      row.next_run_at === null || row.next_run_at === undefined
        ? null
        : pgTimestampToRfc3339(row.next_run_at as string),
    created_at: pgTimestampToRfc3339(row.created_at as string),
    updated_at: pgTimestampToRfc3339(row.updated_at as string),
  };
}

function toOccurrence(row: Record<string, unknown>): AgentRoutineOccurrence {
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

export function isValidTimeZone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function parseIntervalMinutes(raw: string): number | null {
  const text = raw.trim().toLowerCase().replace(/^every\s+/, "");
  const match = /^(\d+)\s*(m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/.exec(text);
  if (match === null) return null;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount < 1) {
    throw ApiError.badRequest("interval must be at least 1 minute");
  }
  const unit = match[2]!;
  if (unit.startsWith("m")) {
    if (amount > 59) throw ApiError.badRequest("minute interval must be 1–59");
    return amount;
  }
  if (unit.startsWith("h")) {
    if (amount > 23) throw ApiError.badRequest("hour interval must be 1–23");
    return amount * 60;
  }
  if (amount > 1) throw ApiError.badRequest("day interval must be 1");
  return amount * 24 * 60;
}

function intervalCron(minutes: number): string {
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = minutes / 60;
  if (hours === 24) return "0 0 * * *";
  return hours === 1 ? "0 * * * *" : `0 */${hours} * * *`;
}

/** Normalizes interval sugar to a five-field cron expression. A raw cron
 *  expression is validated as five fields and must not fire more than once
 *  per minute. */
export function normalizeRoutineSchedule(raw: string, timezone: string): string {
  const schedule = raw.trim();
  if (schedule === "") throw ApiError.badRequest("schedule must not be empty");
  const minutes = parseIntervalMinutes(schedule);
  if (minutes !== null) {
    if (minutes * MIN_INTERVAL_MS < MIN_INTERVAL_MS) {
      throw ApiError.badRequest("minimum interval is 1 minute");
    }
    return intervalCron(minutes);
  }
  if (schedule.split(/\s+/).length !== 5) {
    throw ApiError.badRequest("cron schedule must have five fields");
  }
  const first = nextOccurrence(schedule, timezone, new Date());
  const second = nextOccurrence(schedule, timezone, new Date(first.getTime() + 1_000));
  if (second.getTime() - first.getTime() < MIN_INTERVAL_MS) {
    throw ApiError.badRequest("minimum interval is 1 minute");
  }
  return schedule;
}

/** The next scheduled instant after `from`, evaluated in the routine's IANA
 *  timezone. DST gaps and repeats are resolved by croner. */
export function nextOccurrence(schedule: string, timezone: string, from: Date = new Date()): Date {
  if (!isValidTimeZone(timezone)) throw ApiError.badRequest(`invalid timezone: ${timezone}`);
  let cron: Cron;
  try {
    cron = new Cron(schedule, { timezone, mode: "5-part" });
  } catch (error) {
    throw ApiError.badRequest(`invalid cron schedule: ${(error as Error).message}`);
  }
  const next = cron.nextRun(from);
  if (next === null) throw ApiError.badRequest("schedule has no future occurrence");
  return next;
}

/** The latest scheduled instant before `from`, used when a long gap would
 *  otherwise materialize an unbounded number of occurrences. */
export function previousOccurrence(schedule: string, timezone: string, from: Date = new Date()): Date | null {
  if (!isValidTimeZone(timezone)) throw ApiError.badRequest(`invalid timezone: ${timezone}`);
  const cron = new Cron(schedule, { timezone, mode: "5-part" });
  return cron.previousRuns(1, from)[0] ?? null;
}

function parseRunAt(raw: string): Date {
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) throw ApiError.badRequest("run_at must be an ISO timestamp");
  return date;
}

function cleanName(raw: string): string {
  const name = raw.trim();
  if (name === "") throw ApiError.badRequest("name must not be empty");
  return name;
}

function cleanPrompt(raw: string): string {
  const prompt = raw.trim();
  if (prompt === "") throw ApiError.badRequest("prompt must not be empty");
  return prompt;
}

function cleanTimezone(raw: string | null | undefined): string {
  const timezone = (raw ?? DEFAULT_ROUTINE_TIMEZONE).trim() || DEFAULT_ROUTINE_TIMEZONE;
  if (!isValidTimeZone(timezone)) throw ApiError.badRequest(`invalid timezone: ${timezone}`);
  return timezone;
}

function nextRunAt(input: {
  kind: AgentRoutineKind;
  schedule: string | null;
  timezone: string;
  run_at: string | null;
  enabled: boolean;
}): string | null {
  if (!input.enabled) return null;
  if (input.kind === "cron") {
    return nextOccurrence(input.schedule!, input.timezone, new Date()).toISOString();
  }
  return parseRunAt(input.run_at!).toISOString();
}

export async function listRoutines(pool: PlatformPool, agentId: string): Promise<AgentRoutine[]> {
  const res = await pool.query<Record<string, unknown>>(
    `SELECT ${ROUTINE_COLUMNS} FROM agent_routines r
     WHERE r.agent_id = $1 ORDER BY r.created_at DESC, r.id DESC`,
    [agentId],
  );
  return res.rows.map(toRoutine);
}

export async function getRoutine(pool: PlatformPool, agentId: string, routineId: string): Promise<AgentRoutine> {
  const res = await pool.query<Record<string, unknown>>(
    `SELECT ${ROUTINE_COLUMNS} FROM agent_routines r
     WHERE r.agent_id = $1 AND r.id = $2`,
    [agentId, routineId],
  );
  const row = res.rows[0];
  if (row === undefined) throw ApiError.notFound("no such routine");
  return toRoutine(row);
}

export async function createRoutine(
  pool: PlatformPool,
  agentId: string,
  input: CreateRoutineInput,
): Promise<AgentRoutine> {
  const kind = input.kind;
  if (kind !== "cron" && kind !== "once") throw ApiError.badRequest("kind must be cron or once");
  const timezone = cleanTimezone(input.timezone);
  const enabled = input.enabled ?? true;
  const name = cleanName(input.name);
  const prompt = cleanPrompt(input.prompt);
  const schedule = kind === "cron" ? normalizeRoutineSchedule(input.schedule ?? "", timezone) : null;
  const runAt = kind === "once" ? parseRunAt(input.run_at ?? "").toISOString() : null;
  const next = nextRunAt({ kind, schedule, timezone, run_at: runAt, enabled });
  const id = uuidv7();
  const res = await pool.query<Record<string, unknown>>(
    `WITH r AS (
       INSERT INTO agent_routines
         (id, agent_id, name, kind, schedule, timezone, run_at, prompt, context, enabled, next_run_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8, 'isolated', $9, $10::timestamptz)
       RETURNING *)
     SELECT ${ROUTINE_COLUMNS} FROM r`,
    [id, agentId, name, kind, schedule, timezone, runAt, prompt, enabled, next],
  );
  return toRoutine(res.rows[0]!);
}

export async function updateRoutine(
  pool: PlatformPool,
  agentId: string,
  routineId: string,
  patch: UpdateRoutineInput,
): Promise<AgentRoutine> {
  const existing = await getRoutine(pool, agentId, routineId);
  const kind = patch.kind ?? existing.kind;
  if (kind !== "cron" && kind !== "once") throw ApiError.badRequest("kind must be cron or once");
  const timezone = cleanTimezone(patch.timezone ?? existing.timezone);
  const enabled = patch.enabled ?? existing.enabled;
  const name = patch.name === undefined ? existing.name : cleanName(patch.name);
  const prompt = patch.prompt === undefined ? existing.prompt : cleanPrompt(patch.prompt);
  const schedule =
    kind === "cron"
      ? normalizeRoutineSchedule(patch.schedule ?? existing.schedule ?? "", timezone)
      : null;
  const runAt =
    kind === "once"
      ? parseRunAt(patch.run_at ?? existing.run_at ?? "").toISOString()
      : null;
  const timingChanged =
    patch.kind !== undefined ||
    patch.schedule !== undefined ||
    patch.timezone !== undefined ||
    patch.run_at !== undefined ||
    patch.enabled !== undefined;
  const next =
    timingChanged || existing.next_run_at === null
      ? nextRunAt({ kind, schedule, timezone, run_at: runAt, enabled })
      : existing.next_run_at;
  const res = await pool.query<Record<string, unknown>>(
    `WITH r AS (
       UPDATE agent_routines
       SET name = $3, kind = $4, schedule = $5, timezone = $6, run_at = $7::timestamptz,
           prompt = $8, enabled = $9, next_run_at = $10::timestamptz, updated_at = now()
       WHERE agent_id = $1 AND id = $2
       RETURNING *)
     SELECT ${ROUTINE_COLUMNS} FROM r`,
    [agentId, routineId, name, kind, schedule, timezone, runAt, prompt, enabled, next],
  );
  const row = res.rows[0];
  if (row === undefined) throw ApiError.notFound("no such routine");
  return toRoutine(row);
}

export async function deleteRoutine(pool: PlatformPool, agentId: string, routineId: string): Promise<void> {
  const res = await pool.query("DELETE FROM agent_routines WHERE agent_id = $1 AND id = $2", [agentId, routineId]);
  if (res.rowCount === 0) throw ApiError.notFound("no such routine");
}

/** Inserts one occurrence. `(routine_id, scheduled_for)` is the idempotency
 *  key; a repeated insert returns the existing row. */
export async function createOccurrence(
  pool: PlatformPool,
  routineId: string,
  scheduledFor: Date | string,
): Promise<AgentRoutineOccurrence> {
  const when = typeof scheduledFor === "string" ? new Date(scheduledFor) : scheduledFor;
  if (Number.isNaN(when.getTime())) throw ApiError.badRequest("scheduled_for must be an ISO timestamp");
  const inserted = await pool.query<Record<string, unknown>>(
    `WITH o AS (
       INSERT INTO agent_routine_occurrences (id, routine_id, scheduled_for, status)
       VALUES ($1, $2, $3::timestamptz, 'pending')
       ON CONFLICT (routine_id, scheduled_for) DO NOTHING
       RETURNING *)
     SELECT ${OCCURRENCE_COLUMNS} FROM o`,
    [uuidv7(), routineId, when.toISOString()],
  );
  if (inserted.rows[0] !== undefined) return toOccurrence(inserted.rows[0]);
  const existing = await pool.query<Record<string, unknown>>(
    `SELECT ${OCCURRENCE_COLUMNS} FROM agent_routine_occurrences o
     WHERE o.routine_id = $1 AND o.scheduled_for = $2::timestamptz`,
    [routineId, when.toISOString()],
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

/** Creates a one-shot routine plus its occurrence. Pending reminders are
 *  capped per agent so a runaway conversation cannot fill the schedule. */
export async function scheduleReminder(
  pool: PlatformPool,
  agentId: string,
  input: ReminderInput,
): Promise<ReminderResult> {
  const at = parseRunAt(input.at);
  const prompt = cleanPrompt(input.prompt);
  const pending = await countPendingReminders(pool, agentId);
  if (pending >= MAX_PENDING_REMINDERS) {
    throw ApiError.badRequest(`reminder limit reached (${MAX_PENDING_REMINDERS})`);
  }
  const firstLine = prompt.split(/\r?\n/).find((line) => line.trim() !== "") ?? "Reminder";
  const name = firstLine.length <= 60 ? firstLine : firstLine.slice(0, 60).trim();
  const routine = await createRoutine(pool, agentId, {
    name,
    kind: "once",
    run_at: at.toISOString(),
    prompt,
    enabled: true,
  });
  await createOccurrence(pool, routine.id, at);
  return { routine_id: routine.id, run_at: at.toISOString() };
}
