// Compaction state read from the durable journal: a manual compaction's
// outcome (GET /threads/:id/compactions/:taskId) and whether one is in
// flight (the ThreadState frame's `compacting`). Task and submission records
// are pi-durable JSON text; they decode here.

import {
  chatSubmission,
  compactionActivity,
  compactionTask,
  type DurableQueryable,
} from "../storage/postgres/queries.js";

export type CompactionStatus =
  | { status: "running" }
  | { status: "completed"; compacted: boolean }
  | { status: "failed"; error: string };

interface CompactionOutcome {
  status: string;
  result?: { entryId?: number; submissionId?: number };
  error?: { message?: string };
  reason?: string;
}

/** A manual compaction's state; null when the task is not a compaction of
 *  the chat's conversation. A compaction can finish successfully without
 *  appending a summary. */
export async function compactionStatus(
  db: DurableQueryable,
  chatId: string,
  taskId: number,
): Promise<CompactionStatus | null> {
  const task = await compactionTask(db, chatId, taskId);
  if (task === null) return null;
  const outcome = (JSON.parse(task.record) as { state?: { outcome?: CompactionOutcome } }).state?.outcome ?? null;
  if (task.status !== "terminal") return { status: "running" };
  if (outcome?.status === "completed") {
    const submissionId = outcome.result?.submissionId;
    if (submissionId !== undefined) {
      const placed = await chatSubmission(db, chatId, submissionId);
      const placedRecord =
        placed === null ? undefined : (JSON.parse(placed.record) as { type?: string; reason?: string });
      const write = placedRecord?.type === "write" ? placed : null;
      if (write?.status === "queued") return { status: "running" };
      if (write?.status === "done") return { status: "completed", compacted: true };
      return {
        status: "failed",
        error:
          placedRecord?.reason === "aborted"
            ? "Compaction was cancelled"
            : "Compaction summary was superseded or could not be applied",
      };
    }
    return { status: "completed", compacted: outcome.result?.entryId !== undefined };
  }
  return { status: "failed", error: outcome?.error?.message ?? outcome?.reason ?? "Compaction did not complete" };
}

/** Whether a compaction of the chat's conversation is in flight: its task
 *  is not terminal yet, or the summary it produced is a queued write that
 *  waits for the running turn to end. Every other outcome (a summary, no
 *  summary, a failure) reads false. The only writes a conversation queues
 *  are compaction summaries. */
export async function compactionInFlight(db: DurableQueryable, chatId: string): Promise<boolean> {
  const { running, queued } = await compactionActivity(db, chatId);
  if (running) return true;
  return queued.some((record) => {
    try {
      return (JSON.parse(record) as { type?: unknown }).type === "write";
    } catch {
      return false;
    }
  });
}
