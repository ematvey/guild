// Child-run delivery: a terminal child run's result is submitted to the
// parent's conversation as one steer input, keyed by the child run id
// (chats/child-result.ts). The conversation's inbox is the only queue: the
// parent takes the result at its next boundary, or an idle parent starts a
// run on it, and the parent thread's card is projected from the input's
// entry once placed. A sweep re-delivers a result whose submit never
// landed. A delivery never enqueues a follow-up turn.

import type { Logger } from "pino";
import { withTransaction, type PlatformPool } from "../platform/db.js";
import type { MessageAttachment } from "../platform/domain/thread-events.js";
import { modalityOf } from "../platform/domain/mime.js";
import { pgTimestampToRfc3339 } from "../platform/time.js";
import type { ChildResultEvent } from "../chats/child-result.js";
import { admittedSubmission, undeliveredChildRuns } from "../storage/postgres/queries.js";
import { terminalAssistantText } from "./lifecycle.js";
import type { AgentStore } from "./store.js";
import { childThread, eventAttachments, type ParentThread, parentThreadById, runState } from "./store/delivery.js";
import { assistantEventsSince } from "./store/events.js";

export interface ChildRunFinished {
  /** The child thread whose run ended. */
  child_thread_id: string;
  run_id: string;
  status: string;
  reason: string | null;
  final_text: string;
  /** The child's assistant event that carries its send_file rows. */
  attachment_event_id?: string | null;
}

export interface DeliveryRuntime {
  /** Opens a run row for a parent thread that is idle when the delivery
   *  lands. Returns the new run id. */
  beginRun(thread: { id: string; agent_id: string; user_id: string; depth: number }): Promise<string>;
  /** Submits one child result into the parent chat as a steer input whose
   *  request id is the child run id. */
  submitChildResult(chatId: string, orgId: string, result: ChildResultEvent, model: string | null): Promise<void>;
}

export interface ChildDeliveryDeps {
  pool: PlatformPool;
  store: AgentStore;
  runtime: DeliveryRuntime;
  log: Logger;
}

/** The terminal assistant text of one child run (the message with no tool
 *  call), used when a user stop ends a run without a terminal assistant
 *  event. A stopped run usually has none: the parent gets no partial
 *  narration. */
export async function assistantTextForRun(pool: PlatformPool, chatId: string, since: string): Promise<string> {
  return terminalAssistantText(await assistantEventsSince(pool, chatId, since));
}

export class ChildResultDelivery {
  constructor(private readonly deps: ChildDeliveryDeps) {}

  async deliver(input: ChildRunFinished): Promise<void> {
    const { pool } = this.deps;
    const childRow = await childThread(pool, input.child_thread_id);
    if (childRow === null || childRow.parent_thread_id === null) return;
    // A closed child, or a closed parent subtree, stops deliveries.
    if (childRow.closed_at !== null) return;

    const parentRow = await parentThreadById(pool, childRow.parent_thread_id);
    if (parentRow === null || parentRow.parent_closed_at !== null) return;

    // The store outranks the worker: a run the parent cancelled can still
    // finish somewhere it could not be interrupted, and its completion must
    // not reach the parent as a success. A user stop of the child keeps its
    // own reason and still delivers.
    const run = await runState(pool, input.run_id);
    const cancelled = run?.status === "cancelled";
    const status = cancelled ? "cancelled" : input.status;
    const reason = cancelled && input.status !== "cancelled" ? "parent" : input.reason;
    const startedAt = run?.started_at ?? null;

    const attachments = await this.attachmentsOf(input.attachment_event_id ?? null);
    await this.place(parentRow, {
      type: "child_result",
      thread_id: input.child_thread_id,
      run_id: input.run_id,
      chat_id: childRow.chat_id,
      agent_name: childRow.agent_name,
      title: childRow.title,
      status,
      ...(startedAt === null ? {} : { started_at: pgTimestampToRfc3339(startedAt) }),
      ...(reason === null ? {} : { reason }),
      final_text: input.final_text,
      attachments,
    });
  }

  /** Re-delivers the results of a parent chat whose submit never landed.
   *  The result is rebuilt from the child run: its status, its error and
   *  its terminal text. A sweep calls this. */
  async deliverPending(chatId: string, olderThanMs = 0): Promise<boolean> {
    const runs = await undeliveredChildRuns(this.deps.pool, olderThanMs, chatId);
    for (const run of runs) {
      await this.deliver({
        child_thread_id: run.child_thread_id,
        run_id: run.run_id,
        status: run.status,
        reason: run.error_code === "orphaned" ? "orphaned" : run.status === "failed" ? "error" : null,
        final_text: await assistantTextForRun(this.deps.pool, run.child_chat_id, run.started_at),
      });
    }
    return runs.length > 0;
  }

  /** Submits one result into the parent chat. Deliveries into one parent
   *  are serialized, so concurrent results open at most one run for an
   *  idle parent; a result already admitted is skipped. */
  private async place(parentRow: ParentThread, result: ChildResultEvent): Promise<void> {
    const { pool, store, runtime, log } = this.deps;
    await withTransaction(pool, async (client) => {
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`child-delivery:${parentRow.chat_id}`]);
      if ((await admittedSubmission(pool, parentRow.chat_id, result.run_id)) !== null) return;
      const running = await store.runs.runningRunForChat(parentRow.chat_id);
      const runId =
        running?.id ??
        (await runtime.beginRun({
          id: parentRow.id,
          agent_id: parentRow.agent_id,
          user_id: parentRow.user_id,
          depth: Number(parentRow.depth),
        }));
      try {
        await runtime.submitChildResult(parentRow.chat_id, parentRow.org_id, result, parentRow.model);
      } catch (error) {
        if (running === null) {
          await store.runs
            .updateRun(runId, {
              status: "failed",
              error_code: "delivery_failed",
              error_message: error instanceof Error ? error.message : String(error),
              finished_at: new Date().toISOString(),
            })
            .catch(() => {});
        }
        throw error;
      }
      log.info({ parentThreadId: parentRow.id, runId, childRunId: result.run_id }, "child result delivered");
    });
  }

  private async attachmentsOf(eventId: string | null): Promise<MessageAttachment[]> {
    if (eventId === null) return [];
    const rows = await eventAttachments(this.deps.pool, eventId);
    return rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      content_type: row.content_type,
      size_bytes: Number(row.size_bytes),
      modality: modalityOf(row.content_type),
    }));
  }
}
