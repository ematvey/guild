// writeJournal: the per-turn workspace conflict journal. Tool calls that
// write files append their paths to agent_workspace_turns; overlapping paths between running
// turns produce a notice in the other turn's conversation (its agent reads
// it at the next boundary; the thread row is a log-only system_message)
// and, for the writer, a warning diagnostic on the tool result. The user is
// never notified.
//
// Shell coverage is deliberately best-effort: simple `>`, `>>`, `&>`, and
// `tee` targets are parsed. Paths built at runtime, shell functions, and
// `cd` prefixes are not resolved, so a command can write files the journal
// does not see.

import {
  hook,
  ToolTask,
  type ConversationId,
  type EntryDraft,
  type HookRegistration,
} from "@earendil-works/pi-durable";
import type { ToolCall } from "@earendil-works/pi-ai";
import type { PlatformPool } from "../platform/db.js";
import { noticeEntry } from "../chats/notice.js";
import { systemMessageEvent } from "../platform/domain/thread-events.js";
import { normalizeRelativePath } from "./files.js";
import { threadChatId, threadTitle } from "./store/bindings.js";
import { hasSystemMessageSince } from "./store/events.js";
import {
  addTurnPaths,
  finishRunTurns,
  insertTurn,
  openTurnForRun,
  overlappingTurns,
  type WorkspaceTurnRow,
} from "./store/workspace-turns.js";
import type { AgentStore } from "./store.js";
import type { AgentRun } from "./types.js";

/** Test/support helper: the run's journal row (or null). */
export { workspaceTurnForRun } from "./store/workspace-turns.js";

const MAX_NOTICE_PATHS = 8;

export interface ConflictJournalDeps {
  pool: PlatformPool;
  store: AgentStore;
  /** Writes a notice into another chat's conversation (routed to the
   *  chat's owner). */
  writeEntry(chatId: string, entry: EntryDraft): Promise<void>;
}

export interface WorkspaceTurnRef {
  id: string;
  agent_id: string;
  thread_id: string;
  run_id: string;
  started_at: string;
}

function clipPaths(paths: string[]): string {
  const unique = [...new Set(paths)];
  const shown = unique
    .slice(0, MAX_NOTICE_PATHS)
    .map((item) => `\`${item}\``)
    .join(", ");
  return unique.length > MAX_NOTICE_PATHS ? `${shown} and ${unique.length - MAX_NOTICE_PATHS} more` : shown;
}

function pathArg(args: Record<string, unknown>): string[] {
  const value = args["path"];
  return typeof value === "string" ? [value] : [];
}

/** Paths named by an apply_patch-style payload. The tool is not part of the
 *  current coding extension, but the journal accepts its common headers so a
 *  future or MCP-provided patch tool is covered. */
function patchPaths(args: Record<string, unknown>): string[] {
  const out = pathArg(args);
  const patch =
    typeof args["patch"] === "string" ? args["patch"] : typeof args["input"] === "string" ? args["input"] : "";
  for (const line of patch.split(/\r?\n/)) {
    const match =
      /^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/.exec(line) ?? /^(?:\+\+\+|---)\s+[ab]\/(.+)$/.exec(line);
    if (match?.[1] !== undefined) out.push(match[1].trim());
  }
  return out;
}

/** Simple shell write targets: redirections and tee. See the file header for
 *  the documented limits. */
function shellPaths(command: string): string[] {
  const out: string[] = [];
  const redirect = /(?:^|[^<>&])(?:[0-9]?>>?|&>)\s*(["']?)([^\s;&|<>"']+)\1/g;
  for (const match of command.matchAll(redirect)) {
    if (match[2] !== undefined) out.push(match[2]);
  }
  const tee = /(?:^|[;&|]\s*|\s)tee(?:\s+-a)?(?:\s+--)?\s+(["']?)([^\s;&|<>"']+)\1/g;
  for (const match of command.matchAll(tee)) {
    if (match[2] !== undefined) out.push(match[2]);
  }
  return out;
}

export function writtenPaths(toolName: string, args: Record<string, unknown>): string[] {
  const raw =
    toolName === "write" || toolName === "edit"
      ? pathArg(args)
      : toolName === "apply_patch" || toolName === "apply-patch"
        ? patchPaths(args)
        : toolName === "bash" && typeof args["command"] === "string"
          ? shellPaths(args["command"])
          : [];
  const normalized: string[] = [];
  for (const candidate of raw) {
    if (candidate === "" || candidate === "/dev/null" || candidate.includes("$")) continue;
    try {
      const rel = normalizeRelativePath(candidate);
      if (rel !== "") normalized.push(rel);
    } catch {
      // Absolute paths and traversal attempts are outside the journal.
    }
  }
  return [...new Set(normalized)];
}

export class AgentConflictJournal {
  constructor(private readonly deps: ConflictJournalDeps) {}

  /** Starts (or returns) the unfinished journal row for the chat's running
   *  run. Called at turn begin and lazily by the tool hook. */
  async beginTurn(chatId: string): Promise<WorkspaceTurnRef | null> {
    const run = await this.deps.store.runs.runningRunForChat(chatId);
    if (run === null || run.thread_id === null) return null;
    const existing = await openTurnForRun(this.deps.pool, run.id);
    if (existing !== null) return this.ref(existing);
    return this.ref(await insertTurn(this.deps.pool, { id: run.id, agent_id: run.agent_id, thread_id: run.thread_id }));
  }

  /** Marks the run's open turn finished. Idempotent; safe when no turn was
   *  ever started. */
  async finishRun(runId: string): Promise<void> {
    await finishRunTurns(this.deps.pool, runId);
  }

  /** Records one tool call's write paths and returns a model-visible notice
   *  for the writer when another running turn touched an overlapping path
   *  after this turn's baseline. Also appends reciprocal system messages to
   *  the other turn's thread. */
  async recordToolCall(chatId: string, toolName: string, args: Record<string, unknown>): Promise<string | null> {
    const paths = writtenPaths(toolName, args);
    if (paths.length === 0) return null;
    const turn = await this.beginTurn(chatId);
    if (turn === null) return null;
    const mine = await addTurnPaths(this.deps.pool, turn.id, paths);
    if (mine === null) return null;
    const others = await overlappingTurns(this.deps.pool, mine, paths);
    const writerNotices: string[] = [];
    for (const other of others) {
      const otherTitle = await this.threadTitle(other.thread_id);
      const otherStarted = other.started_at.getTime();
      const myStarted = mine.started_at.getTime();
      const overlap = other.paths.filter((item) => paths.includes(item));
      if (overlap.length === 0) continue;
      // Paths carry no per-touch timestamp in the journal schema, so an
      // overlap with another running turn is reported to both sides. The
      // conservative extra notice is preferable to a missed conflict.
      writerNotices.push(`Thread ${otherTitle} modified ${clipPaths(overlap)} — re-read before editing.`);
      if (otherStarted <= myStarted) {
        await this.appendNotice(other, mine, paths);
      }
    }
    return writerNotices.length === 0 ? null : writerNotices.join(" ");
  }

  private ref(row: WorkspaceTurnRow): WorkspaceTurnRef {
    return {
      id: row.id,
      agent_id: row.agent_id,
      thread_id: row.thread_id,
      run_id: row.run_id,
      started_at: row.started_at.toISOString(),
    };
  }

  private async threadTitle(threadId: string): Promise<string> {
    return (await threadTitle(this.deps.pool, threadId))?.trim() || threadId;
  }

  private async appendNotice(other: WorkspaceTurnRow, writer: WorkspaceTurnRow, paths: string[]): Promise<void> {
    const chatId = await threadChatId(this.deps.pool, other.thread_id);
    if (chatId === null) return;
    const title = await this.threadTitle(writer.thread_id);
    const text = `Thread ${title} modified ${clipPaths(paths)} — re-read before editing.`;
    if (await hasSystemMessageSince(this.deps.pool, chatId, text, other.started_at.toISOString())) return;
    await this.deps.writeEntry(chatId, noticeEntry(text, systemMessageEvent(text)));
  }
}

/** The tool-task hook that feeds the journal. Only write-shaped tools are
 *  inspected; the hook never blocks a call. */
export function createConflictHook(
  journal: AgentConflictJournal,
  chatOfConversation: (conversationId: ConversationId) => Promise<string | null>,
): HookRegistration {
  return hook(ToolTask, {
    afterTool: async (call: ToolCall, result, api) => {
      try {
        const chatId = await chatOfConversation(api.conversationId);
        if (chatId === null) return result;
        const notice = await journal.recordToolCall(chatId, call.name, call.arguments as Record<string, unknown>);
        if (notice === null) return result;
        return {
          ...result,
          diagnostics: [
            ...(result.diagnostics ?? []),
            { severity: "warn" as const, message: notice, code: "workspace_conflict" },
          ],
        };
      } catch {
        return result;
      }
    },
  });
}

export type { AgentRun };
