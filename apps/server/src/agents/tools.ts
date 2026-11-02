// Agent conversation tools: send_message opens a user-visible thread, while
// conversations_search and conversation_read stay inside the calling agent's
// own threads. All three are script-callable (callers: ["tools"]), matching
// the thread-history tools' exposure.

import { Type } from "typebox";
import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { PlatformPool } from "../platform/db.js";
import type { ThreadStore } from "../platform/store/thread.js";
import { assistantMessageEvent } from "../platform/domain/thread-events.js";
import { AgentStore, deriveTitleFromMessage } from "./store.js";
import {
  createRoutine,
  deleteRoutine,
  listRoutines,
  scheduleReminder,
  updateRoutine,
} from "./routines.js";
import { createSubagentTools, type SubagentsToolContext } from "./subagents.js";
import { createSendFileTool, type SendFileContext } from "./send-file.js";
import { readThreadTranscript, type ThreadReadResult } from "./thread-read.js";
import { ALL_AGENT_TOOLS, MAX_AGENT_DESCRIPTION_CHARS, type Agent } from "./types.js";
import { structured } from "../harness/tool-schema.js";

const MAX_SEARCH_RESULTS = 20;

export interface AgentToolDeps {
  pool: PlatformPool;
  store: AgentStore;
  threads: ThreadStore;
  agent: Agent;
  /** The user whose private thread this run serves: a thread this tool
   *  creates belongs to them. */
  userId: string;
  /** The chat this turn runs in. A thread the agent opens records it as its
   *  origin, so the agent can read the run behind a delivered message. */
  chatId?: string;
  /** Present only when this chat has a running run and the subagent tree is
   *  addressable. */
  subagents?: SubagentsToolContext;
  /** Present when this chat has a running agent turn. */
  sendFile?: SendFileContext;
}

export { createSubagentTools } from "./subagents.js";
export { createSendFileTool } from "./send-file.js";

export interface AgentMessageResult {
  thread_id: string;
  url: string;
}

/** Creates the user-visible thread, appends the assistant message, moves the
 *  thread activity marker and writes the inbox notice. The chat's unread
 *  projection follows from the new assistant event. */
export async function sendAgentMessage(
  deps: Pick<AgentToolDeps, "pool" | "store" | "threads" | "agent" | "userId" | "chatId">,
  args: { text: string; title?: string },
): Promise<AgentMessageResult> {
  const text = args.text.trim();
  if (text === "") throw new Error("text must not be empty");
  const title = (args.title ?? "").trim() || deriveTitleFromMessage(text);
  // A model that calls send_message twice with the same content in one run
  // must not open two threads; the recent identical thread is the result.
  const existing = await deps.pool.query<{ id: string; chat_id: string }>(
    `SELECT id, chat_id FROM agent_threads
     WHERE agent_id = $1 AND title = $2 AND created_at > now() - interval '1 minute'
     ORDER BY created_at DESC LIMIT 1`,
    [deps.agent.id, title],
  );
  if (existing.rows[0] !== undefined) {
    return {
      thread_id: existing.rows[0].id,
      url: `/thread/${existing.rows[0].chat_id}`,
    };
  }
  const origin = deps.chatId === undefined ? null : await deps.store.threadByChatId(deps.chatId);
  const thread = await deps.store.createThread(deps.agent.id, deps.userId, title, "user", {
    ...(origin === null ? {} : { originThreadId: origin.id }),
  });
  await deps.threads.appendEvent(
    thread.chat_id,
    assistantMessageEvent(
      1,
      1,
      [{ type: "text", text }],
      { tokens_in: 0, tokens_out: 0, cost_usd: 0 },
      deps.agent.model,
    ),
  );
  await deps.store.touchThread(deps.agent.id, thread.id);
  // One canonical address per thread: its chat.
  const url = `/thread/${thread.chat_id}`;
  await deps.store.createNotice({
    org_id: deps.agent.org_id,
    agent_id: deps.agent.id,
    user_id: deps.userId,
    kind: "agent_message",
    payload: { thread_id: thread.id, url, title: thread.title },
  });
  return { thread_id: thread.id, url };
}

export async function searchAgentConversations(
  store: AgentStore,
  agentId: string,
  userId: string,
  query: string,
  limit?: number,
): Promise<Awaited<ReturnType<AgentStore["searchThreads"]>>> {
  const capped = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(limit ?? MAX_SEARCH_RESULTS)));
  return store.searchThreads(agentId, userId, query, capped);
}

export type AgentConversationRead = ThreadReadResult;

/** Bounded read of one of the user's threads with this agent. Another
 *  agent's or another user's thread id is the same not-found answer as a
 *  missing one. */
export async function readAgentConversation(
  pool: PlatformPool,
  agentId: string,
  userId: string,
  args: { threadId: string; fromSeq?: number; toSeq?: number },
): Promise<AgentConversationRead | null> {
  const owned = await pool.query<{ chat_id: string; title: string }>(
    `SELECT t.chat_id, t.title FROM agent_threads t
     WHERE t.id = $1 AND t.agent_id = $2 AND t.user_id = $3`,
    [args.threadId, agentId, userId],
  );
  const thread = owned.rows[0];
  if (thread === undefined) return null;
  return readThreadTranscript(pool, {
    threadId: args.threadId,
    chatId: thread.chat_id,
    title: thread.title,
    ...(args.fromSeq === undefined ? {} : { fromSeq: args.fromSeq }),
    ...(args.toSeq === undefined ? {} : { toSeq: args.toSeq }),
  });
}

const textErr = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

const messageOutput = Type.Object({
  thread_id: Type.String(),
  url: Type.String(),
});

const searchOutput = Type.Object({
  hits: Type.Array(
    Type.Object({
      thread_id: Type.String(),
      thread_title: Type.String(),
      seq_from: Type.Number(),
      seq_to: Type.Number(),
      ts: Type.String(),
      snippet: Type.String(),
      rank: Type.Number(),
    }),
  ),
});

const reminderOutput = Type.Object({
  routine_id: Type.String(),
  run_at: Type.String(),
});

const routineOutput = Type.Object({
  id: Type.String(),
  name: Type.String(),
  kind: Type.String(),
  schedule: Type.Union([Type.String(), Type.Null()]),
  timezone: Type.String(),
  prompt: Type.String(),
  enabled: Type.Boolean(),
  next_run_at: Type.Union([Type.String(), Type.Null()]),
});

const routineListOutput = Type.Object({
  routines: Type.Array(routineOutput),
});

const MAX_THREAD_LIST = 100;

const listedThreadOutput = Type.Object({
  thread_id: Type.String(),
  chat_id: Type.String(),
  title: Type.String(),
  type: Type.String(),
  is_default: Type.Boolean(),
  parent_thread_id: Type.Union([Type.String(), Type.Null()]),
  archived: Type.Boolean(),
  deleted: Type.Boolean(),
  created_at: Type.String(),
  last_activity_at: Type.String(),
});

const threadListOutput = Type.Object({
  threads: Type.Array(listedThreadOutput),
  next_cursor: Type.Union([Type.String(), Type.Null()]),
});

const readOutput = Type.Object({
  thread_id: Type.String(),
  thread_title: Type.String(),
  events: Type.Array(
    Type.Object({
      seq: Type.Number(),
      type: Type.String(),
      ts: Type.String(),
      text: Type.String(),
    }),
  ),
  truncated: Type.Boolean(),
});

export function createAgentTools(deps: AgentToolDeps): ToolRegistration[] {
  // `all` follows the catalog, so a tool added in a later release reaches
  // the agent without an edit.
  const allowed = new Set(deps.agent.tools_mode === "all" ? ALL_AGENT_TOOLS : deps.agent.tools);
  // Outside the allowlist: every agent owns its own description.
  const tools: ToolRegistration[] = [
    defineTool({
      name: "set_description",
      description:
        "Rewrite your own description: the short text other agents read to know what you are for. " +
        `At most ${MAX_AGENT_DESCRIPTION_CHARS} characters; an empty string clears it. This never changes another agent.`,
      parameters: Type.Object({
        description: Type.String({
          description: `Your new description, at most ${MAX_AGENT_DESCRIPTION_CHARS} characters; empty clears it`,
        }),
      }),
      structuredOutputSchema: Type.Object({ description: Type.String() }),
      replay: "unsafe",
      callers: ["tools"],
      outputLimits: { maxBytes: 4 * 1024 },
      execute: async (args) => {
        const description = args.description.trim();
        if (description.length > MAX_AGENT_DESCRIPTION_CHARS) {
          return textErr(`description must be at most ${MAX_AGENT_DESCRIPTION_CHARS} characters`);
        }
        try {
          const stored = await deps.store.setDescription(deps.agent.id, description);
          return { structuredOutput: structured({ description: stored }) };
        } catch (error) {
          return textErr(error instanceof Error ? error.message : String(error));
        }
      },
    }),
  ];

  if (allowed.has("send_message")) {
    tools.push(
      defineTool({
        name: "send_message",
        description:
          "Open a new conversation with the user and post a message into it. This is how a run reaches the user; " +
          "the new thread appears in the user's Chats list and an inbox notice is written.",
        parameters: Type.Object({
          text: Type.String({ description: "The message to show the user" }),
          title: Type.Optional(Type.String({ description: "Optional short thread title" })),
        }),
        structuredOutputSchema: messageOutput,
        replay: "unsafe",
        callers: ["tools"],
        outputLimits: { maxBytes: 16 * 1024 },
        execute: async (args) => {
          const result = await sendAgentMessage(deps, { text: args.text, title: args.title });
          return { structuredOutput: structured(result) };
        },
      }),
    );
  }

  if (allowed.has("conversations_search")) {
    tools.push(
      defineTool({
        name: "conversations_search",
        description:
          "Search this agent's own conversation threads by text. Returns snippet hits with thread ids, titles and " +
          "seq bounds; use conversation_read to read a hit.",
        parameters: Type.Object({
          query: Type.String({ description: "Text to search for (max 512 chars)" }),
          limit: Type.Optional(Type.Number({ description: `Max hits, 1–${MAX_SEARCH_RESULTS}` })),
        }),
        structuredOutputSchema: searchOutput,
        replay: "safe",
        callers: ["tools"],
        outputLimits: { maxBytes: 32 * 1024 },
        execute: async (args) => {
          const query = args.query.trim();
          if (query === "") return textErr("query must not be empty");
          const hits = await searchAgentConversations(deps.store, deps.agent.id, deps.userId, query, args.limit);
          return { structuredOutput: structured({ hits }) };
        },
      }),
    );
  }

  if (allowed.has("conversations_list")) {
    tools.push(
      defineTool({
        name: "conversations_list",
        description:
          "List this agent's own conversation threads, one page at a time. Filter by type (user, subagent, " +
          "routine), by archived or deleted state, or by parent thread. Sort by activity or creation time. " +
          "Pass next_cursor back to read the next page.",
        parameters: Type.Object({
          type: Type.Optional(
            Type.Union([Type.Literal("user"), Type.Literal("subagent"), Type.Literal("routine")], {
              description: "Thread type; omit for user threads only",
            }),
          ),
          archived: Type.Optional(
            Type.Boolean({ description: "true = archived only; omit or false = active only" }),
          ),
          deleted: Type.Optional(
            Type.Boolean({ description: "true = deleted only; omit or false hides deleted threads" }),
          ),
          parent_thread_id: Type.Optional(
            Type.String({ description: "Only the children of this thread id" }),
          ),
          sort: Type.Optional(
            Type.Union(
              [
                Type.Literal("activity_desc"),
                Type.Literal("activity_asc"),
                Type.Literal("created_desc"),
                Type.Literal("created_asc"),
              ],
              { description: "Sort order; default activity_desc" },
            ),
          ),
          limit: Type.Optional(Type.Number({ description: `Max threads, 1–${MAX_THREAD_LIST}` })),
          cursor: Type.Optional(Type.String({ description: "next_cursor from the previous page" })),
        }),
        structuredOutputSchema: threadListOutput,
        replay: "safe",
        callers: ["tools"],
        outputLimits: { maxBytes: 64 * 1024 },
        execute: async (args) => {
          try {
            const page = await deps.store.listThreads(deps.agent.id, deps.userId, {
              types: [args.type ?? "user"],
              archived: args.archived === true,
              deleted: args.deleted === true,
              ...(args.parent_thread_id === undefined ? {} : { parentThreadId: args.parent_thread_id }),
              ...(args.sort === undefined ? {} : { sort: args.sort }),
              ...(args.limit === undefined ? {} : { limit: args.limit }),
              ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
            });
            return {
              structuredOutput: structured({
                threads: page.threads.map((thread) => ({
                  thread_id: thread.id,
                  chat_id: thread.chat_id,
                  title: thread.title,
                  type: thread.type,
                  is_default: thread.is_default,
                  parent_thread_id: thread.parent_thread_id,
                  archived: thread.archived,
                  deleted: thread.deleted,
                  created_at: thread.created_at,
                  last_activity_at: thread.last_activity_at,
                })),
                next_cursor: page.next_cursor,
              }),
            };
          } catch (error) {
            return textErr(error instanceof Error ? error.message : String(error));
          }
        },
      }),
    );
  }

  if (allowed.has("schedule_reminder")) {
    tools.push(
      defineTool({
        name: "schedule_reminder",
        description:
          "Create a one-shot reminder for this agent. At the given time the agent runs an isolated turn with " +
          "the prompt and may message the user. Pending reminders are capped per agent.",
        parameters: Type.Object({
          at: Type.String({ description: "ISO timestamp when the reminder should run" }),
          prompt: Type.String({ description: "The reminder prompt and context for the future run" }),
        }),
        structuredOutputSchema: reminderOutput,
        replay: "unsafe",
        callers: ["tools"],
        outputLimits: { maxBytes: 16 * 1024 },
        execute: async (args) => {
          try {
            const result = await scheduleReminder(deps.pool, deps.agent.id, {
              created_by_user_id: deps.userId,
              at: args.at,
              prompt: args.prompt,
            });
            return { structuredOutput: structured(result) };
          } catch (error) {
            return textErr(error instanceof Error ? error.message : String(error));
          }
        },
      }),
    );
  }

  if (allowed.has("list_routines")) {
    tools.push(
      defineTool({
        name: "list_routines",
        description:
          "List this agent's routines with their stored schedule, timezone, prompt, enabled state and next run. " +
          "Use this before changing or deleting a routine so you can cite its id.",
        parameters: Type.Object({}),
        structuredOutputSchema: routineListOutput,
        replay: "safe",
        callers: ["tools"],
        outputLimits: { maxBytes: 32 * 1024 },
        execute: async () => {
          const routines = await listRoutines(deps.pool, deps.agent.id);
          return { structuredOutput: structured({ routines }) };
        },
      }),
    );
  }

  if (allowed.has("create_routine")) {
    tools.push(
      defineTool({
        name: "create_routine",
        description:
          "Create a recurring routine for this agent. Pass a five-field cron expression or interval sugar " +
          "such as 'every 2 hours' or 'every day'. The user sees a human-readable schedule: never show the " +
          "raw cron expression, describe the result in plain language instead.",
        parameters: Type.Object({
          name: Type.String({ description: "Short routine name" }),
          prompt: Type.String({ description: "The prompt the isolated routine run receives" }),
          schedule: Type.String({ description: "Five-field cron or interval such as 'every 2 hours'" }),
          timezone: Type.Optional(Type.String({ description: "IANA timezone, default UTC" })),
          enabled: Type.Optional(Type.Boolean({ description: "Start enabled (default true)" })),
        }),
        structuredOutputSchema: routineOutput,
        replay: "unsafe",
        callers: ["tools"],
        outputLimits: { maxBytes: 16 * 1024 },
        execute: async (args) => {
          try {
            const routine = await createRoutine(deps.pool, deps.agent.id, {
              created_by_user_id: deps.userId,
              name: args.name,
              prompt: args.prompt,
              kind: "cron",
              schedule: args.schedule,
              timezone: args.timezone ?? "UTC",
              enabled: args.enabled ?? true,
            });
            return { structuredOutput: structured(routine) };
          } catch (error) {
            return textErr(error instanceof Error ? error.message : String(error));
          }
        },
      }),
    );
  }

  if (allowed.has("update_routine")) {
    tools.push(
      defineTool({
        name: "update_routine",
        description:
          "Change a routine's name, prompt, schedule, timezone or enabled state. Omitted fields stay as they are. " +
          "Use list_routines first when you need the routine id. Describe schedule changes in plain language; " +
          "do not show the raw cron expression to the user.",
        parameters: Type.Object({
          routine_id: Type.String({ description: "The routine id" }),
          name: Type.Optional(Type.String()),
          prompt: Type.Optional(Type.String()),
          schedule: Type.Optional(Type.String({ description: "Five-field cron or interval such as 'every 2 hours'" })),
          timezone: Type.Optional(Type.String()),
          enabled: Type.Optional(Type.Boolean()),
        }),
        structuredOutputSchema: routineOutput,
        replay: "unsafe",
        callers: ["tools"],
        outputLimits: { maxBytes: 16 * 1024 },
        execute: async (args) => {
          try {
            const routine = await updateRoutine(deps.pool, deps.agent.id, args.routine_id, {
              ...(args.name === undefined ? {} : { name: args.name }),
              ...(args.prompt === undefined ? {} : { prompt: args.prompt }),
              ...(args.schedule === undefined ? {} : { schedule: args.schedule }),
              ...(args.timezone === undefined ? {} : { timezone: args.timezone }),
              ...(args.enabled === undefined ? {} : { enabled: args.enabled }),
            });
            return { structuredOutput: structured(routine) };
          } catch (error) {
            return textErr(error instanceof Error ? error.message : String(error));
          }
        },
      }),
    );
  }

  if (allowed.has("delete_routine")) {
    tools.push(
      defineTool({
        name: "delete_routine",
        description:
          "Delete a routine and stop its schedule. Use only after the user has confirmed the deletion.",
        parameters: Type.Object({
          routine_id: Type.String({ description: "The routine id" }),
        }),
        structuredOutputSchema: Type.Object({ deleted: Type.Boolean(), routine_id: Type.String() }),
        replay: "unsafe",
        callers: ["tools"],
        outputLimits: { maxBytes: 4 * 1024 },
        execute: async (args) => {
          try {
            await deleteRoutine(deps.pool, deps.agent.id, args.routine_id);
            return {
              structuredOutput: structured({ deleted: true, routine_id: args.routine_id }),
            };
          } catch (error) {
            return textErr(error instanceof Error ? error.message : String(error));
          }
        },
      }),
    );
  }

  if (allowed.has("subagents") && deps.subagents !== undefined) {
    tools.push(...createSubagentTools(deps.subagents));
  }

  if (allowed.has("send_file") && deps.sendFile !== undefined) {
    tools.push(createSendFileTool(deps.sendFile));
  }

  if (allowed.has("conversation_read")) {
    tools.push(
      defineTool({
        name: "conversation_read",
        description:
          "Read a bounded transcript excerpt from one of this agent's own threads (max 200 events, 20k chars). " +
          "Pass from_seq/to_seq from a conversation_search hit to narrow the range.",
        parameters: Type.Object({
          thread_id: Type.String({ description: "The agent thread id" }),
          from_seq: Type.Optional(Type.Number({ description: "First event seq to include" })),
          to_seq: Type.Optional(Type.Number({ description: "Last event seq to include" })),
        }),
        structuredOutputSchema: readOutput,
        replay: "safe",
        callers: ["tools"],
        outputLimits: { maxBytes: 32 * 1024 },
        execute: async (args) => {
          const read = await readAgentConversation(deps.pool, deps.agent.id, deps.userId, {
            threadId: args.thread_id,
            fromSeq: args.from_seq,
            toSeq: args.to_seq,
          });
          if (read === null) return textErr("not_found");
          return { structuredOutput: structured(read) };
        },
      }),
    );
  }

  return tools;
}

