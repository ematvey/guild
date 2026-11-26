// Agent routines: durable cron/one-shot definitions plus their occurrence
// rows. A routine is owned by one agent; an occurrence is the idempotent
// scheduled instant `(routine_id, scheduled_for)` the scheduler claims.
// Interval sugar is normalized to a five-field cron expression so every
// schedule has one representation in the database.

import { Cron } from "croner";
import { ApiError } from "../platform/errors.js";
import { withTransaction, type PlatformPool } from "../platform/db.js";
import {
  countPendingReminders,
  deletePendingOccurrences,
  deleteRoutineRow,
  insertOccurrence,
  insertRoutine,
  selectRoutine,
  writeRoutine,
} from "./store/routines.js";
import type { AgentRoutine, AgentRoutineDelivery, AgentRoutineKind, AgentRoutineOccurrence } from "./types.js";

export { countPendingReminders, listOccurrences, listRoutines } from "./store/routines.js";

export const DEFAULT_ROUTINE_TIMEZONE = "UTC";
export const MIN_INTERVAL_MS = 60_000;
export const MAX_PENDING_REMINDERS = 20;

export interface CreateRoutineInput {
  id?: string;
  created_by_user_id: string;
  name: string;
  kind: AgentRoutineKind;
  schedule?: string | null;
  timezone?: string | null;
  run_at?: string | null;
  prompt: string;
  delivery?: AgentRoutineDelivery | null;
  enabled?: boolean;
}

export interface UpdateRoutineInput {
  name?: string;
  kind?: AgentRoutineKind;
  schedule?: string | null;
  timezone?: string | null;
  run_at?: string | null;
  prompt?: string;
  delivery?: AgentRoutineDelivery | null;
  enabled?: boolean;
}

export interface ReminderInput {
  created_by_user_id: string;
  at: string;
  prompt: string;
}

export interface ReminderResult {
  routine_id: string;
  run_at: string;
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
  const text = raw
    .trim()
    .toLowerCase()
    .replace(/^every\s+/, "");
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

function cleanDelivery(raw: string | null | undefined, fallback: AgentRoutineDelivery): AgentRoutineDelivery {
  if (raw === undefined || raw === null) return fallback;
  if (raw !== "thread" && raw !== "new_chat") throw ApiError.badRequest("delivery must be thread or new_chat");
  return raw;
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

export async function getRoutine(pool: PlatformPool, agentId: string, routineId: string): Promise<AgentRoutine> {
  const routine = await selectRoutine(pool, agentId, routineId);
  if (routine === null) throw ApiError.notFound("no such routine");
  return routine;
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
  return insertRoutine(pool, agentId, {
    ...(input.id === undefined ? {} : { id: input.id }),
    created_by_user_id: input.created_by_user_id,
    name,
    kind,
    schedule,
    timezone,
    run_at: runAt,
    prompt,
    delivery: cleanDelivery(input.delivery, "thread"),
    enabled,
    next_run_at: next,
  });
}

export async function updateRoutine(
  pool: PlatformPool,
  agentId: string,
  routineId: string,
  patch: UpdateRoutineInput,
): Promise<AgentRoutine> {
  return withTransaction(pool, async (client) => {
    const existing = await selectRoutine(client, agentId, routineId, true);
    if (existing === null) throw ApiError.notFound("no such routine");
    const kind = patch.kind ?? existing.kind;
    if (kind !== "cron" && kind !== "once") throw ApiError.badRequest("kind must be cron or once");
    const timezone = cleanTimezone(patch.timezone ?? existing.timezone);
    const enabled = patch.enabled ?? existing.enabled;
    const name = patch.name === undefined ? existing.name : cleanName(patch.name);
    const prompt = patch.prompt === undefined ? existing.prompt : cleanPrompt(patch.prompt);
    const schedule =
      kind === "cron" ? normalizeRoutineSchedule(patch.schedule ?? existing.schedule ?? "", timezone) : null;
    const runAt = kind === "once" ? parseRunAt(patch.run_at ?? existing.run_at ?? "").toISOString() : null;
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
    const updated = await writeRoutine(client, agentId, routineId, {
      name,
      kind,
      schedule,
      timezone,
      run_at: runAt,
      prompt,
      delivery: cleanDelivery(patch.delivery, existing.delivery),
      enabled,
      next_run_at: next,
    });
    if (updated === null) throw ApiError.notFound("no such routine");
    if (!enabled || (kind === "once" && patch.run_at !== undefined)) {
      await deletePendingOccurrences(client, routineId);
    }
    return updated;
  });
}

export async function deleteRoutine(pool: PlatformPool, agentId: string, routineId: string): Promise<void> {
  if (!(await deleteRoutineRow(pool, agentId, routineId))) throw ApiError.notFound("no such routine");
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
  return insertOccurrence(pool, routineId, when.toISOString());
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
    created_by_user_id: input.created_by_user_id,
    name,
    kind: "once",
    run_at: at.toISOString(),
    prompt,
    enabled: true,
  });
  await createOccurrence(pool, routine.id, at);
  return { routine_id: routine.id, run_at: at.toISOString() };
}
