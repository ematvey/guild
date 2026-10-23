// Child-run delivery: a terminal child run writes one child_result event in
// the parent thread, then a parent run drains the unconsumed batch in one
// transaction and receives it as one steer input. A delivery never enqueues
// its own turn.

import type { Logger } from "pino";
import type { PlatformPool } from "../platform/db.js";
import type { MessageAttachment } from "../platform/domain/thread-events.js";
import type { ThreadStore, ChildResultRecord } from "../platform/store/thread.js";
import { modalityOf } from "../chats/turn-text.js";
import type { AgentStore } from "./store.js";

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
  /** Places or merges one steer input into the parent chat. */
  deliverSteer(chatId: string, orgId: string, text: string, model: string | null): Promise<void>;
}

export interface ChildDeliveryDeps {
  pool: PlatformPool;
  store: AgentStore;
  threads: ThreadStore;
  runtime: DeliveryRuntime;
  log: Logger;
}

interface ParentThread {
  id: string;
  chat_id: string;
  agent_id: string;
  user_id: string;
  depth: number;
  org_id: string;
  model: string;
  parent_closed_at: Date | null;
}

function formatChildResults(rows: readonly ChildResultRecord[]): string {
  return rows
    .map((row) => {
      const event = row.event;
      const reason = event.reason === null || event.reason === undefined ? "" : ` (${event.reason})`;
      const lines = [
        `Child result at ${row.created_at}:`,
        `thread ${event.thread_id} run ${event.run_id}: ${event.status}${reason}`,
      ];
      const text = event.final_text.trim();
      lines.push(text === "" ? "(no final text)" : text);
      if (event.attachments.length > 0) {
        lines.push(
          `Files: ${event.attachments
            .map((attachment) => `${attachment.filename} (${attachment.id})`)
            .join(", ")}`,
        );
      }
      return lines.join("\n");
    })
    .join("\n\n");
}

/** The last assistant text of one child run, used when a user stop ends a
 *  run without a terminal assistant event. */
export async function assistantTextForRun(
  pool: PlatformPool,
  chatId: string,
  since: string,
): Promise<string> {
  const res = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT payload FROM thread_events
     WHERE chat_id = $1 AND type = 'assistant_message'
       AND created_at >= $2::timestamptz
     ORDER BY seq ASC`,
    [chatId, since],
  );
  const texts: string[] = [];
  for (const row of res.rows) {
    const blocks = Array.isArray(row.payload.blocks)
      ? (row.payload.blocks as { type?: string; text?: string }[])
      : [];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
        texts.push(block.text);
      }
    }
  }
  return texts.join("\n\n").trim();
}

export class ChildResultDelivery {
  constructor(private readonly deps: ChildDeliveryDeps) {}

  async deliver(input: ChildRunFinished): Promise<void> {
    const { pool, store, threads, runtime, log } = this.deps;
    const child = await pool.query<{
      parent_thread_id: string | null;
      closed_at: Date | null;
      chat_id: string;
      agent_name: string;
      title: string;
    }>(
      `SELECT t.parent_thread_id, t.closed_at, t.chat_id, t.title, a.name AS agent_name
       FROM agent_threads t JOIN agents a ON a.id = t.agent_id WHERE t.id = $1`,
      [input.child_thread_id],
    );
    const childRow = child.rows[0];
    if (childRow === undefined || childRow.parent_thread_id === null) return;
    // A closed child, or a closed parent subtree, stops deliveries.
    if (childRow.closed_at !== null) return;

    const parent = await pool.query<ParentThread>(
      `SELECT t.id, t.chat_id, t.agent_id, t.user_id, t.depth,
              t.closed_at AS parent_closed_at, c.org_id, a.model
       FROM agent_threads t
       JOIN chats c ON c.id = t.chat_id
       JOIN agents a ON a.id = t.agent_id
       WHERE t.id = $1`,
      [childRow.parent_thread_id],
    );
    const parentRow = parent.rows[0];
    if (parentRow === undefined || parentRow.parent_closed_at !== null) return;

    // The store outranks the worker: a run the parent cancelled can still
    // finish somewhere it could not be interrupted, and its completion must
    // not reach the parent as a success. A user stop of the child keeps its
    // own reason and still delivers.
    const run = await pool.query<{ status: string }>(
      "SELECT status FROM agent_runs WHERE id = $1",
      [input.run_id],
    );
    const cancelled = run.rows[0]?.status === "cancelled";
    const status = cancelled ? "cancelled" : input.status;
    const reason = cancelled && input.status !== "cancelled" ? "parent" : input.reason;

    const attachments = await this.attachmentsOf(input.attachment_event_id ?? null);
    await threads.appendChildResult(parentRow.chat_id, {
      type: "child_result",
      thread_id: input.child_thread_id,
      run_id: input.run_id,
      chat_id: childRow.chat_id,
      agent_name: childRow.agent_name,
      title: childRow.title,
      status,
      reason,
      final_text: input.final_text,
      attachments,
    });

    const running = await store.runningRunForChat(parentRow.chat_id);
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
        await store
          .updateRun(runId, { status: "skipped", finished_at: new Date().toISOString() })
          .catch(() => {});
      }
      return;
    }
    await runtime.deliverSteer(parentRow.chat_id, parentRow.org_id, formatChildResults(batch), parentRow.model);
    log.info(
      { parentThreadId: parentRow.id, childThreadId: input.child_thread_id, runId, count: batch.length },
      "child result delivered",
    );
  }

  private async attachmentsOf(eventId: string | null): Promise<MessageAttachment[]> {
    if (eventId === null) return [];
    const res = await this.deps.pool.query<{
      id: string;
      filename: string;
      content_type: string;
      size_bytes: number;
    }>(
      `SELECT id, filename, content_type, size_bytes FROM attachments
       WHERE event_id = $1 ORDER BY created_at ASC, id ASC`,
      [eventId],
    );
    return res.rows.map((row) => ({
      id: row.id,
      filename: row.filename,
      content_type: row.content_type,
      size_bytes: Number(row.size_bytes),
      modality: modalityOf(row.content_type),
    }));
  }
}
