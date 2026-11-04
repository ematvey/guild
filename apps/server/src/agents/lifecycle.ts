// Run lifecycle for agent threads: the transcript projection reports
// assistant events, the chat bridge reports run end, and this class turns
// those observations into one terminal agent_runs update plus the turn's
// search chunk. The run row is the durable identity; the update is guarded
// by status so a completion can only be written once.

import type { Logger } from "pino";
import type { PlatformPool } from "../platform/db.js";
import { threadEventText, type ThreadEventRow } from "../platform/domain/thread-events.js";
import { insertChunks } from "./search.js";
import { insertChunkOnce } from "./store/chunks.js";
import type { AgentConflictJournal } from "./conflict.js";
import type { TraceStore } from "../platform/trace.js";
import type { AttachmentStore } from "../platform/store/attachments.js";
import { assistantTextForRun, type ChildResultDelivery, type ChildRunFinished } from "./delivery.js";
import { chatThreadAgent, chatThreadNode } from "./store/bindings.js";
import { turnEventsSince } from "./store/events.js";
import {
  cancelOpenRuns,
  type OpenChatRun,
  openedThreadSince,
  openRunForChat,
  runTraceRow,
  settleRun,
} from "./store/run-finish.js";
import { notifySubagentTree } from "./store/tree.js";

const MAX_SUMMARY_CHARS = 500;
const MAX_CHUNK_CHARS = 4_000;
/** The conversation events a run's search chunk carries. */
const INDEXED_TYPES = new Set(["user_message", "assistant_message", "child_result"]);

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
  /** Delivers a finished child run to its parent thread. */
  delivery?: Pick<ChildResultDelivery, "deliver">;
  /** Names a fresh thread from its first turn. Runs after the run settles;
   *  a locked or already-named thread is left alone. */
  title?: (chatId: string, threadId: string) => Promise<void>;
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

/** The terminal assistant message of a turn: the one with no tool call. Only
 *  that message is the run's answer; earlier assistant rows are narration
 *  around tool calls. */
function terminalAssistantEvent(
  events: readonly { type: string; payload: Record<string, unknown> }[],
): { type: string; payload: Record<string, unknown> } | null {
  const assistant = events.filter((event) => event.type === "assistant_message");
  for (let i = assistant.length - 1; i >= 0; i--) {
    const event = assistant[i]!;
    if (!blocksOf(event.payload).some((block) => block.type === "tool_call")) return event;
  }
  return null;
}

/** The terminal assistant text of a turn: the last assistant message with no
 *  tool call, its text blocks joined and trimmed. Only that message is the
 *  run's answer; earlier assistant rows are narration around tool calls. */
export function terminalAssistantText(events: readonly { type: string; payload: Record<string, unknown> }[]): string {
  const terminal = terminalAssistantEvent(events);
  return terminal === null ? "" : textOf(terminal.payload).trim();
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
      const events = await turnEventsSince(this.deps.pool, run.chat_id, since);
      const turnEvents: TurnEvent[] = events.map((row) => ({
        seq: Number(row.seq),
        type: row.type,
        payload: row.payload,
        created_at: row.created_at,
      }));
      const finalText = terminalAssistantText(turnEvents);
      const tokens = turnEvents.reduce((sum, event) => {
        if (event.type !== "assistant_message") return sum;
        const usage = event.payload.usage as { tokens_in?: number; tokens_out?: number } | undefined;
        return sum + Number(usage?.tokens_in ?? 0) + Number(usage?.tokens_out ?? 0);
      }, 0);
      const sentMessage = await this.sentMessage(run, since);
      const status = info.error !== null ? "failed" : finalText !== "" || sentMessage ? "succeeded" : "silent";
      const summary =
        info.summary ?? (finalText !== "" ? clip(finalText, MAX_SUMMARY_CHARS) : sentMessage ? "Sent a message" : null);
      const settled = await settleRun(this.deps.pool, run.id, {
        status,
        summary: summary === null || summary === "" ? null : summary,
        tokens,
        error_code: info.error === null ? null : "run_error",
        error_message: info.error,
      });
      if (!settled) return;
      await notifySubagentTree(this.deps.pool, run.thread_id);
      if (status === "succeeded" && this.deps.title !== undefined) {
        void this.deps.title(run.chat_id, run.thread_id).catch((error: unknown) => {
          this.deps.log.warn({ err: error, chatId: run.chat_id }, "thread title generation failed");
        });
      }
      if (info.eventId !== undefined) {
        await this.deps.attachments?.publishAgentAttachments(run.chat_id, info.eventId).catch((error: unknown) => {
          this.deps.log.warn({ err: error, runId: run.id, chatId }, "attachment publish failed");
        });
      }
      await this.deps.journal?.finishRun(run.id);
      this.mirrorFinishedRun(run.id);
      await this.indexTurn(run, turnEvents);
      if (this.deps.delivery !== undefined) {
        const finished: ChildRunFinished = {
          child_thread_id: run.thread_id,
          run_id: run.id,
          status,
          reason: info.error === null ? null : "error",
          final_text: finalText,
          attachment_event_id: info.eventId ?? null,
        };
        await this.deps.delivery.deliver(finished).catch((error: unknown) => {
          this.deps.log.warn({ err: error, runId: run.id, chatId }, "child result delivery failed");
        });
      }
    } catch (error) {
      this.deps.log.warn({ err: error, runId: run.id, chatId }, "agent run completion failed");
    }
  }

  /** Writes the terminal run row to ClickHouse (agent_traces). */
  private mirrorFinishedRun(runId: string): void {
    if (this.deps.trace === undefined) return;
    void runTraceRow(this.deps.pool, runId)
      .then((row) => {
        if (row === null) return;
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

  private async runningRun(chatId: string): Promise<OpenChatRun | null> {
    return openRunForChat(this.deps.pool, chatId);
  }

  /** send_message opens a new thread; that row is the run's durable signal
   *  that it reached the user even when it wrote no assistant text. */
  private async sentMessage(run: OpenChatRun, since: string): Promise<boolean> {
    return openedThreadSince(this.deps.pool, run.agent_id, run.thread_id, since);
  }

  private async indexTurn(run: OpenChatRun, events: TurnEvent[]): Promise<void> {
    const parts: string[] = [];
    let seqFrom: number | null = null;
    let seqTo: number | null = null;
    let used = 0;
    for (const event of events) {
      if (!INDEXED_TYPES.has(event.type)) continue;
      const text = threadEventText(event.type, event.payload);
      if (text.trim() === "") continue;
      const role = event.type === "assistant_message" ? "Assistant" : "User";
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

  /** Indexes a message posted into a thread outside its runs (send_message:
   *  a routine feed has no run to index it at the run's end). Idempotent
   *  per row, so a projection replay adds nothing. */
  async postedMessage(chatId: string, row: ThreadEventRow): Promise<void> {
    if (row.event.type !== "assistant_message") return;
    const thread = await chatThreadAgent(this.deps.pool, chatId);
    if (thread === null) return;
    const text = threadEventText(row.event.type, row.event as unknown as Record<string, unknown>);
    if (text.trim() === "") return;
    await insertChunkOnce(this.deps.pool, {
      thread_id: thread.id,
      agent_id: thread.agent_id,
      seq_from: row.seq,
      seq_to: row.seq,
      text: clip(`Assistant: ${text}`, MAX_CHUNK_CHARS),
    });
  }

  /** A user stop of a child chat is a delivered cancellation: its queued
   *  and running runs are marked cancelled, then the parent wakes with
   *  cancelled/user. A root chat's runs are left to the run-end path. */
  async cancelChildOnStop(chatId: string): Promise<void> {
    const row = await chatThreadNode(this.deps.pool, chatId);
    if (row === null || row.parent_thread_id === null) return;
    const runs = await cancelOpenRuns(this.deps.pool, row.id);
    if (runs.length === 0) return;
    await notifySubagentTree(this.deps.pool, row.id);
    for (const run of runs) {
      this.mirrorFinishedRun(run.id);
      const finalText = await assistantTextForRun(this.deps.pool, chatId, run.started_at).catch(() => "");
      await this.deps.delivery
        ?.deliver({
          child_thread_id: row.id,
          run_id: run.id,
          status: "cancelled",
          reason: "user",
          final_text: finalText,
        })
        .catch((error: unknown) => this.deps.log.warn({ err: error, chatId, runId: run.id }, "cancel delivery failed"));
    }
  }
}
