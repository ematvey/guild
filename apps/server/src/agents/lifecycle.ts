// Run lifecycle for agent threads: an agent_runs row is the database copy
// of one pi-durable run (`pi.live.run`). The run's first model request
// opens it, taking over the queued row a delegated or routine turn created
// for its input, and the bridge's run_end settles it from the run's answer,
// with the turn's search chunk. Nothing else decides when a run starts or
// ends. The update is guarded by status so a completion is written once.

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
import { assistantTokensSince, terminalAssistantSince, turnEventsSince } from "./store/events.js";
import {
  cancelOpenRuns,
  type OpenChatRun,
  openedThreadSince,
  queuedRunsFor,
  requestingMember,
  runningRunsForChat,
  runThread,
  runTraceRow,
  settleRun,
} from "./store/run-finish.js";
import type { AgentRunStore } from "./store/runs.js";
import { inputRequestIds } from "../storage/postgres/queries.js";
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
  /** Opens and takes over run rows (mirrored and pushed like any write). */
  runs: Pick<AgentRunStore, "createRun" | "updateRun">;
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

const sameInputs = (a: readonly number[], b: readonly number[]) => a.length === b.length && includesAll(a, b);
const includesAll = (inputs: readonly number[], of: readonly number[]) => of.every((input) => inputs.includes(input));

export class AgentRunLifecycle {
  /** Per chat, the inputs of the run whose rows are open: later requests
   *  of the same run skip the lookup. */
  private readonly opened = new Map<string, readonly number[]>();
  /** Per chat, a run this process settled when the next run started, with
   *  its rows: its own run_end, still on the way, only adds a failure. */
  private readonly settledEarly = new Map<string, { inputs: readonly number[]; runIds: string[] }>();

  constructor(private readonly deps: AgentRunLifecycleDeps) {}

  /** Called before every model request of a run (pi-durable's
   *  `beforeRequest`), including a run resumed after a restart. The first
   *  one opens the run's rows: the queued rows created for its inputs, else
   *  a new message run. A row already running is this run's own. */
  async runStart(chatId: string, inputs: readonly number[]): Promise<void> {
    const current = this.opened.get(chatId);
    if (current !== undefined && sameInputs(current, inputs)) return;
    if (current !== undefined && !includesAll(inputs, current)) {
      // A run's inputs only grow (a steer or child result taken into it),
      // so inputs without the open run's are another run. pi-durable runs
      // one run at a time per conversation: the open one has ended, even
      // when its run_end has not arrived yet (inputs waiting in the inbox
      // start the next run at once). Settle it now, or its open row would
      // swallow this run.
      const running = await runningRunsForChat(this.deps.pool, chatId);
      for (const run of running) await this.finish(run, null);
      this.settledEarly.set(chatId, { inputs: current, runIds: running.map((run) => run.id) });
    }
    await this.open(chatId, inputs, true);
    this.opened.set(chatId, inputs);
  }

  /** Called at the chat bridge's run_end: settles the run's rows from its
   *  answer. A run that ended before any request still settles the queued
   *  rows created for its inputs, and a failed one is recorded. */
  async runEnd(chatId: string, inputs: readonly number[], failure: string | null): Promise<void> {
    const early = this.settledEarly.get(chatId);
    if (early !== undefined && includesAll(inputs, early.inputs)) {
      this.settledEarly.delete(chatId);
      if (failure !== null) {
        for (const id of early.runIds) {
          await this.deps.runs.updateRun(id, { status: "failed", error_code: "run_error", error_message: failure });
        }
      }
      return;
    }
    const current = this.opened.get(chatId);
    if (current === undefined || !sameInputs(current, inputs)) await this.open(chatId, inputs, failure !== null);
    this.opened.delete(chatId);
    for (const run of await runningRunsForChat(this.deps.pool, chatId)) await this.finish(run, failure);
  }

  private async open(chatId: string, inputs: readonly number[], create: boolean): Promise<void> {
    const { pool, runs } = this.deps;
    const thread = await runThread(pool, chatId);
    if (thread === null) return;
    if ((await runningRunsForChat(pool, chatId)).length > 0) return;
    const requestIds = await inputRequestIds(pool, inputs);
    const queued = await queuedRunsFor(pool, thread.id, requestIds);
    const startedAt = new Date().toISOString();
    if (queued.length > 0) {
      for (const id of queued) await runs.updateRun(id, { status: "running", started_at: startedAt });
      return;
    }
    if (!create) return;
    await runs.createRun({
      agent_id: thread.agent_id,
      user_id: (await requestingMember(pool, chatId, requestIds)) ?? thread.user_id,
      thread_id: thread.id,
      depth: Number(thread.depth),
      trigger: "message",
      status: "running",
      started_at: startedAt,
    });
  }

  private async finish(run: OpenChatRun, error: string | null): Promise<void> {
    const { pool } = this.deps;
    try {
      const since = run.started_at;
      const answer = await terminalAssistantSince(pool, run.chat_id, since);
      const finalText = answer === null ? "" : textOf(answer.payload).trim();
      const answerError = typeof answer?.payload.error === "string" ? answer.payload.error : null;
      const failure = error ?? answerError;
      const tokens = await assistantTokensSince(pool, run.chat_id, since);
      const sentMessage = await this.sentMessage(run, since);
      const status = failure !== null ? "failed" : finalText !== "" || sentMessage ? "succeeded" : "silent";
      const firstText = answer === null ? "" : clip(firstTextOf(answer.payload), MAX_SUMMARY_CHARS);
      const summary =
        firstText !== ""
          ? firstText
          : finalText !== ""
            ? clip(finalText, MAX_SUMMARY_CHARS)
            : sentMessage
              ? "Sent a message"
              : null;
      const settled = await settleRun(pool, run.id, {
        status,
        summary,
        tokens,
        error_code: failure === null ? null : "run_error",
        error_message: failure,
      });
      if (!settled) return;
      await notifySubagentTree(pool, run.thread_id);
      if (status === "succeeded" && this.deps.title !== undefined) {
        void this.deps.title(run.chat_id, run.thread_id).catch((titleError: unknown) => {
          this.deps.log.warn({ err: titleError, chatId: run.chat_id }, "thread title generation failed");
        });
      }
      if (answer !== null) {
        await this.deps.attachments?.publishAgentAttachments(run.chat_id, answer.id).catch((publishError: unknown) => {
          this.deps.log.warn({ err: publishError, runId: run.id, chatId: run.chat_id }, "attachment publish failed");
        });
      }
      await this.deps.journal?.finishRun(run.id);
      this.mirrorFinishedRun(run.id);
      const events = await turnEventsSince(pool, run.chat_id, since);
      await this.indexTurn(
        run,
        events.map((row) => ({
          seq: Number(row.seq),
          type: row.type,
          payload: row.payload,
          created_at: row.created_at,
        })),
      );
      if (this.deps.delivery !== undefined) {
        const finished: ChildRunFinished = {
          child_thread_id: run.thread_id,
          run_id: run.id,
          status,
          reason: failure === null ? null : "error",
          final_text: finalText,
          attachment_event_id: answer?.id ?? null,
        };
        await this.deps.delivery.deliver(finished).catch((deliveryError: unknown) => {
          this.deps.log.warn(
            { err: deliveryError, runId: run.id, chatId: run.chat_id },
            "child result delivery failed",
          );
        });
      }
    } catch (finishError) {
      this.deps.log.warn({ err: finishError, runId: run.id, chatId: run.chat_id }, "agent run completion failed");
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
