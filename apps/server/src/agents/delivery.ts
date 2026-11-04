// Child-run delivery: a terminal child run queues one result for its parent
// chat, then a parent run drains the unconsumed results in one transaction
// and places them as one steer batch (chats/child-result.ts). The parent
// thread's cards are projected from that batch's entry when the
// conversation places it, so a result the parent never received never
// shows. A delivery never enqueues its own turn.

import type { Logger } from "pino";
import type { PlatformPool } from "../platform/db.js";
import type { MessageAttachment } from "../platform/domain/thread-events.js";
import type { ThreadStore, ChildResultRecord } from "../platform/store/thread.js";
import { modalityOf } from "../platform/domain/mime.js";
import { pgTimestampToRfc3339 } from "../platform/time.js";
import { terminalAssistantText } from "./lifecycle.js";
import type { AgentStore } from "./store.js";
import {
  childThread,
  eventAttachments,
  type ParentThread,
  parentThreadById,
  rootThreadForChat,
  runState,
} from "./store/delivery.js";
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
  /** Places a batch of child results in the parent chat: merged into its
   *  pending child-result steer, else submitted as a new one. */
  deliverChildResults(chatId: string, orgId: string, results: ChildResultRecord[], model: string | null): Promise<void>;
}

export interface ChildDeliveryDeps {
  pool: PlatformPool;
  store: AgentStore;
  threads: ThreadStore;
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
    const { pool, threads } = this.deps;
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
    await threads.queueChildResult(parentRow.chat_id, {
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

    await this.wake(parentRow);
  }

  /** Drains the unconsumed results of one parent chat into a turn. A sweep
   *  calls this for a chat whose earlier delivery did not land. */
  async deliverPending(chatId: string): Promise<boolean> {
    const parentRow = await rootThreadForChat(this.deps.pool, chatId);
    if (parentRow === null || parentRow.parent_closed_at !== null) return false;
    return this.wake(parentRow);
  }

  /** Places every unconsumed result of the parent chat as one steer batch in
   *  one run. A batch that cannot be placed goes back to the unconsumed pool
   *  so a later attempt can still deliver it. */
  private async wake(parentRow: ParentThread): Promise<boolean> {
    const { store, threads, runtime, log } = this.deps;
    const running = await store.runs.runningRunForChat(parentRow.chat_id);
    let runId = running?.id ?? null;
    let opened = false;
    if (runId === null) {
      runId = await runtime.beginRun({
        id: parentRow.id,
        agent_id: parentRow.agent_id,
        user_id: parentRow.user_id,
        depth: Number(parentRow.depth),
      });
      opened = true;
    }

    const batch = await threads.consumeChildResults(parentRow.chat_id, runId);
    if (batch.length === 0) {
      // A concurrent drain took the batch. An idle-parent run we opened has
      // nothing to do, so it must not stay running.
      if (opened) {
        await store.runs.updateRun(runId, { status: "skipped", finished_at: new Date().toISOString() }).catch(() => {});
      }
      return false;
    }
    try {
      await runtime.deliverChildResults(parentRow.chat_id, parentRow.org_id, batch, parentRow.model);
    } catch (error) {
      await threads.releaseChildResults(batch.map((row) => row.id)).catch((releaseError: unknown) => {
        log.warn({ err: releaseError, chatId: parentRow.chat_id }, "child result release failed");
      });
      if (opened) {
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
    log.info({ parentThreadId: parentRow.id, runId, count: batch.length }, "child result delivered");
    return true;
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
