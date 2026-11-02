// The workspace conflict journal's rows (agent_workspace_turns): one row per
// running turn with the paths its tool calls wrote.

import type { PlatformPool } from "../../platform/db.js";
import { uuidv7 } from "../../platform/time.js";

export interface WorkspaceTurnRow {
  id: string;
  agent_id: string;
  thread_id: string;
  run_id: string;
  started_at: Date;
  paths: string[];
}

const TURN_COLUMNS = "id, agent_id, thread_id, run_id, started_at, paths";

/** The run's oldest unfinished turn, or null. */
export async function openTurnForRun(pool: PlatformPool, runId: string): Promise<WorkspaceTurnRow | null> {
  const res = await pool.query<WorkspaceTurnRow>(
    `SELECT ${TURN_COLUMNS}
     FROM agent_workspace_turns
     WHERE run_id = $1 AND finished_at IS NULL
     ORDER BY started_at ASC LIMIT 1`,
    [runId],
  );
  return res.rows[0] ?? null;
}

/** Opens a turn row for the run with no paths. */
export async function insertTurn(
  pool: PlatformPool,
  run: { id: string; agent_id: string; thread_id: string },
): Promise<WorkspaceTurnRow> {
  const inserted = await pool.query<WorkspaceTurnRow>(
    `INSERT INTO agent_workspace_turns (id, agent_id, thread_id, run_id, started_at, paths)
     VALUES ($1, $2, $3, $4, now(), '{}')
     RETURNING ${TURN_COLUMNS}`,
    [uuidv7(), run.agent_id, run.thread_id, run.id],
  );
  return inserted.rows[0]!;
}

/** Marks the run's open turns finished. */
export async function finishRunTurns(pool: PlatformPool, runId: string): Promise<void> {
  await pool.query(
    `UPDATE agent_workspace_turns SET finished_at = now()
     WHERE run_id = $1 AND finished_at IS NULL`,
    [runId],
  );
}

/** Adds paths to a turn (deduplicated, sorted) and returns the row. */
export async function addTurnPaths(
  pool: PlatformPool,
  turnId: string,
  paths: string[],
): Promise<WorkspaceTurnRow | null> {
  await pool.query(
    `UPDATE agent_workspace_turns
     SET paths = (
       SELECT COALESCE(array_agg(DISTINCT p ORDER BY p), '{}')
       FROM unnest(paths || $2::text[]) AS p
     )
     WHERE id = $1`,
    [turnId, paths],
  );
  const current = await pool.query<WorkspaceTurnRow>(
    `SELECT ${TURN_COLUMNS} FROM agent_workspace_turns WHERE id = $1`,
    [turnId],
  );
  return current.rows[0] ?? null;
}

/** The agent's other unfinished turns, on other threads, that touched any
 *  of `paths`, oldest first. */
export async function overlappingTurns(
  pool: PlatformPool,
  turn: { id: string; agent_id: string; thread_id: string },
  paths: string[],
): Promise<WorkspaceTurnRow[]> {
  const res = await pool.query<WorkspaceTurnRow>(
    `SELECT ${TURN_COLUMNS}
     FROM agent_workspace_turns
     WHERE agent_id = $1 AND id <> $2 AND finished_at IS NULL
       AND thread_id <> $3 AND paths && $4::text[]
     ORDER BY started_at ASC`,
    [turn.agent_id, turn.id, turn.thread_id, paths],
  );
  return res.rows;
}

/** The run's first turn row (or null). */
export async function workspaceTurnForRun(
  pool: PlatformPool,
  runId: string,
): Promise<{ id: string; paths: string[]; finished: boolean } | null> {
  const res = await pool.query<{ id: string; paths: string[]; finished_at: Date | null }>(
    "SELECT id, paths, finished_at FROM agent_workspace_turns WHERE run_id = $1 ORDER BY started_at ASC LIMIT 1",
    [runId],
  );
  const row = res.rows[0];
  return row === undefined ? null : { id: row.id, paths: row.paths, finished: row.finished_at !== null };
}
