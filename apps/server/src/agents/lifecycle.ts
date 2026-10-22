// Run lifecycle for agent threads: the transcript projection reports
// assistant events, the chat bridge reports run end, and this class turns
// those observations into one terminal agent_runs update plus the turn's
// search chunk. The run row is the durable identity; the update is guarded
// by status so a completion can only be written once.

import type { Logger } from "pino";
import type { PlatformPool } from "../platform/db.js";
import type { ThreadEventRow } from "../platform/domain/thread-events.js";
import { insertChunks } from "./search.js";
import type { AgentConflictJournal } from "./conflict.js";
import type { TraceStore } from "../platform/trace.js";
import type { AttachmentStore } from "../platform/store/attachments.js";

const MAX_SUMMARY_CHARS = 500;
const MAX_CHUNK_CHARS = 4_000;

interface RunningRun {
  id: string;
  agent_id: string;
  thread_id: string;
  chat_id: string;
  started_at: string;
}

interface TurnEvent {
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  created_at: Date;
}

export interface AgentRunLifecycleDeps {
  pool: PlatformPool;
  log: Logger;
  /** Finishes the run's workspace-turn journal row at completion. */
  journal?: AgentConflictJournal;
  /** Mirrors the terminal run row into ClickHouse. */
  trace?: TraceStore;
  /** Binds the turn's pending agent attachments to its assistant event. */
  attachments?: Pick<AttachmentStore, "publishAgentAttachments">;
}

function blocksOf(payload: Record<string, unknown>): { type?: string; text?: string }[] {
  return Array.isArray(payload.blocks) ? (payload.blocks as { type?: string; text?: string }[]) : [];
}

function textOf(payload: Record<string, unknown>): string {
  return blocksOf(payload)
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text!)
    .join("\n");
}

function firstTextOf(payload: Record<string, unknown>): string {
  const block = blocksOf(payload).find((item) => item.type === "text" && typeof item.text === "string");
  return block?.text ?? "";
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max);
}

export class AgentRunLifecycle {
  constructor(private readonly deps: AgentRunLifecycleDeps) {}

  /** Called after an assistant_message row lands. A tool-call round is not
   *  the run's end; a terminal assistant event (text/error, no tool call)
   *  completes the run. */
  async assistantEvent(chatId: string, row: ThreadEventRow): Promise<void> {
    if (row.event.type !== "assistant_message") return;
    const payload = row.event as unknown as Record<string, unknown>;
    const hasToolCall = blocksOf(payload).some((block) => block.type === "tool_call");
    const error = typeof payload.error === "string" ? payload.error : null;
    if (!error && hasToolCall) return;
    await this.finish(chatId, {
      error,
      summary: clip(firstTextOf(payload), MAX_SUMMARY_CHARS) || null,
      finalSeq: row.seq,
      eventId: row.id,
    });
  }

  /** Called at the chat bridge's run_end: the fallback that makes a run
   *  with no assistant text silent (or succeeded when it sent a message). */
  async runEnd(chatId: string, failure: string | null): Promise<void> {
    await this.finish(chatId, { error: failure, summary: null });
  }

  private async finish(
    chatId: string,
    info: { error: string | null; summary: string | null; finalSeq?: number; eventId?: string },
  ): Promise<void> {
    const run = await this.runningRun(chatId);
    if (run === null) return;
    try {
      const since = run.started_at;
      const events = await this.deps.pool.query<{
        seq: string;
        type: string;
        payload: Record<string, unknown>;
        created_at: Date;
      }>(
        `SELECT e.seq, e.type, e.payload, e.created_at
         FROM thread_events e
         WHERE e.chat_id = $1 AND e.created_at >= $2::timestamptz
         ORDER BY e.seq ASC
         LIMIT 400`,
        [run.chat_id, since],
      );
      const turnEvents: TurnEvent[] = events.rows.map((row) => ({
        seq: Number(row.seq),
        type: row.type,
        payload: row.payload,
        created_at: row.created_at,
      }));
      const assistantText = turnEvents
        .filter((event) => event.type === "assistant_message")
        .map((event) => textOf(event.payload))
        .filter((text) => text.trim() !== "")
        .join("\n\n");
      const tokens = turnEvents.reduce((sum, event) => {
        if (event.type !== "assistant_message") return sum;
        const usage = event.payload.usage as { tokens_in?: number; tokens_out?: number } | undefined;
        return sum + Number(usage?.tokens_in ?? 0) + Number(usage?.tokens_out ?? 0);
      }, 0);
      const sentMessage = await this.sentMessage(run, since);
      const status =
        info.error !== null
          ? "failed"
          : assistantText.trim() !== "" || sentMessage
            ? "succeeded"
            : "silent";
      const summary =
        info.summary ??
        (assistantText.trim() !== ""
          ? clip(firstTextOf(turnEvents.find((event) => event.type === "assistant_message")?.payload ?? {}), MAX_SUMMARY_CHARS)
          : sentMessage
            ? "Sent a message"
            : null);
      const updated = await this.deps.pool.query<{ id: string }>(
        `UPDATE agent_runs
         SET status = $2, summary = $3, tokens = $4, finished_at = now(),
             error_code = $5, error_message = $6
         WHERE id = $1 AND status IN ('queued', 'running')
         RETURNING id`,
        [
          run.id,
          status,
          summary === null || summary === "" ? null : summary,
          tokens,
          info.error === null ? null : "run_error",
          info.error,
        ],
      );
      if (updated.rowCount === 0) return;
      if (info.eventId !== undefined) {
        await this.deps.attachments?.publishAgentAttachments(run.chat_id, info.eventId).catch((error: unknown) => {
          this.deps.log.warn({ err: error, runId: run.id, chatId }, "attachment publish failed");
        });
      }
      await this.deps.journal?.finishRun(run.id);
      this.mirrorFinishedRun(run.id);
      await this.indexTurn(run, turnEvents);
    } catch (error) {
      this.deps.log.warn({ err: error, runId: run.id, chatId }, "agent run completion failed");
    }
  }

  /** Writes the terminal run row to ClickHouse (agent_traces). */
  private mirrorFinishedRun(runId: string): void {
    if (this.deps.trace === undefined) return;
    void this.deps.pool
      .query<Record<string, unknown>>(
        `SELECT r.id, r.agent_id, r.user_id, r.thread_id, r.routine_id, r.parent_run_id,
                r.trigger, r.status, r.summary, r.error_message, r.tokens,
                r.started_at, r.finished_at, r.created_at,
                a.org_id, a.name AS agent_name, t.chat_id
         FROM agent_runs r
         JOIN agents a ON a.id = r.agent_id
         LEFT JOIN agent_threads t ON t.id = r.thread_id
         WHERE r.id = $1`,
        [runId],
      )
      .then((res) => {
        const row = res.rows[0];
        if (row === undefined) return;
        return this.deps.trace!.recordTrace({
          trace_id: String(row["id"]),
          org_id: String(row["org_id"]),
          user_id: row["user_id"] === null ? null : String(row["user_id"]),
          agent_id: String(row["agent_id"]),
          agent_name: String(row["agent_name"] ?? ""),
          session_id: row["chat_id"] === null ? null : String(row["chat_id"]),
          thread_id: row["thread_id"] === null ? null : String(row["thread_id"]),
          parent_trace_id: row["parent_run_id"] === null ? null : String(row["parent_run_id"]),
          routine_id: row["routine_id"] === null ? null : String(row["routine_id"]),
          trigger: String(row["trigger"]),
          status: String(row["status"]),
          name: String(row["agent_name"] ?? ""),
          summary: String(row["summary"] ?? ""),
          error: String(row["error_message"] ?? ""),
          started_at: new Date((row["started_at"] ?? row["created_at"]) as string | Date),
          finished_at: row["finished_at"] === null ? null : new Date(row["finished_at"] as string | Date),
        });
      })
      .catch(() => {});
  }

  private async runningRun(chatId: string): Promise<RunningRun | null> {
    const res = await this.deps.pool.query<{
      id: string;
      agent_id: string;
      thread_id: string;
      chat_id: string;
      started_at: string;
    }>(
      `SELECT r.id, r.agent_id, r.thread_id, t.chat_id,
              to_char(COALESCE(r.started_at, r.created_at) AT TIME ZONE 'UTC',
                      'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS started_at
       FROM agent_runs r JOIN agent_threads t ON t.id = r.thread_id
       WHERE t.chat_id = $1 AND r.status IN ('queued', 'running')
       ORDER BY r.created_at ASC, r.id ASC
       LIMIT 1`,
      [chatId],
    );
    return res.rows[0] ?? null;
  }

  /** send_message opens a new thread; that row is the run's durable signal
   *  that it reached the user even when it wrote no assistant text. */
  private async sentMessage(run: RunningRun, since: string): Promise<boolean> {
    const res = await this.deps.pool.query(
      `SELECT 1 FROM agent_threads
       WHERE agent_id = $1 AND id <> $2 AND created_at >= $3::timestamptz
       LIMIT 1`,
      [run.agent_id, run.thread_id, since],
    );
    return (res.rowCount ?? 0) > 0;
  }

  private async indexTurn(run: RunningRun, events: TurnEvent[]): Promise<void> {
    const parts: string[] = [];
    let seqFrom: number | null = null;
    let seqTo: number | null = null;
    let used = 0;
    for (const event of events) {
      if (event.type !== "user_message" && event.type !== "assistant_message") continue;
      const text = event.type === "user_message" ? String(event.payload.content ?? "") : textOf(event.payload);
      if (text.trim() === "") continue;
      const role = event.type === "user_message" ? "User" : "Assistant";
      const line = `${role}: ${text}`;
      const room = MAX_CHUNK_CHARS - used;
      if (room <= 0) break;
      parts.push(clip(line, room));
      used += Math.min(line.length, room);
      seqFrom ??= event.seq;
      seqTo = event.seq;
    }
    if (parts.length === 0 || seqFrom === null || seqTo === null) return;
    await insertChunks(this.deps.pool, [
      {
        thread_id: run.thread_id,
        agent_id: run.agent_id,
        seq_from: seqFrom,
        seq_to: seqTo,
        text: parts.join("\n\n"),
      },
    ]);
  }
}
