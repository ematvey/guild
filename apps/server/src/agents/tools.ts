// Agent conversation tools: send_message opens a user-visible thread, while
// conversations_search and conversation_read stay inside the calling agent's
// own threads. All three are script-callable (callers: ["tools"]), matching
// the thread-history tools' exposure.

import { Type } from "typebox";
import type { JsonValue } from "@earendil-works/chord";
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
import { createDelegateTool, createReleaseArtifactsTool, type DelegationToolContext } from "./delegation.js";
import { ALL_AGENT_TOOLS, type Agent } from "./types.js";

const MAX_SEARCH_RESULTS = 20;
const MAX_READ_EVENTS = 200;
const MAX_READ_CHARS = 20_000;
const MAX_EVENT_CHARS = 4_000;

export interface AgentToolDeps {
  pool: PlatformPool;
  store: AgentStore;
  threads: ThreadStore;
  agent: Agent;
  /** The user whose private thread this run serves: a thread this tool
   *  creates belongs to them. */
  userId: string;
  /** Present only when this chat has a running run and the delegation limits
   *  still allow spawning. */
  delegation?: DelegationToolContext;
}

export { createDelegateTool, createReleaseArtifactsTool } from "./delegation.js";

export interface AgentMessageResult {
  thread_id: string;
  url: string;
}

/** Creates the user-visible thread, appends the assistant message, moves the
 *  thread activity marker and writes the inbox notice. The chat's unread
 *  projection follows from the new assistant event. */
export async function sendAgentMessage(
  deps: Pick<AgentToolDeps, "pool" | "store" | "threads" | "agent" | "userId">,
  args: { text: string; title?: string },
): Promise<AgentMessageResult> {
  const text = args.text.trim();
  if (text === "") throw new Error("text must not be empty");
  const title = (args.title ?? "").trim() || deriveTitleFromMessage(text);
  // A model that calls send_message twice with the same content in one run
  // must not open two threads; the recent identical thread is the result.
  const existing = await deps.pool.query<{ id: string }>(
    `SELECT id FROM agent_threads
     WHERE agent_id = $1 AND title = $2 AND created_at > now() - interval '1 minute'
     ORDER BY created_at DESC LIMIT 1`,
    [deps.agent.id, title],
  );
  if (existing.rows[0] !== undefined) {
    return {
      thread_id: existing.rows[0].id,
      url: `/agents/${deps.agent.id}/threads/${existing.rows[0].id}`,
    };
  }
  const thread = await deps.store.createThread(deps.agent.id, deps.userId, title);
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
  const url = `/agents/${deps.agent.id}/threads/${thread.id}`;
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
  query: string,
  limit?: number,
): Promise<Awaited<ReturnType<AgentStore["searchThreads"]>>> {
  const capped = Math.max(1, Math.min(MAX_SEARCH_RESULTS, Math.floor(limit ?? MAX_SEARCH_RESULTS)));
  return store.searchThreads(agentId, query, capped);
}

function eventText(type: string, payload: Record<string, unknown>): string {
  if (type === "user_message" || type === "system_message" || type === "tool_result") {
    return typeof payload.content === "string" ? payload.content : "";
  }
  if (type === "assistant_message" && Array.isArray(payload.blocks)) {
    return (payload.blocks as { type?: string; text?: string }[])
      .filter((block) => block.type === "text" && typeof block.text === "string")
      .map((block) => block.text!)
      .join("\n");
  }
  return "";
}

function clip(text: string, max = MAX_EVENT_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

export interface AgentConversationRead {
  thread_id: string;
  thread_title: string;
  events: { seq: number; type: string; ts: string; text: string }[];
  truncated: boolean;
}

/** Bounded read of one of the agent's own threads. A foreign thread id is
 *  the same not-found answer as a missing one. */
export async function readAgentConversation(
  pool: PlatformPool,
  agentId: string,
  args: { threadId: string; fromSeq?: number; toSeq?: number },
): Promise<AgentConversationRead | null> {
  const owned = await pool.query<{ chat_id: string; title: string }>(
    `SELECT t.chat_id, t.title FROM agent_threads t
     WHERE t.id = $1 AND t.agent_id = $2`,
    [args.threadId, agentId],
  );
  const thread = owned.rows[0];
  if (thread === undefined) return null;
  const params: unknown[] = [thread.chat_id];
  let where = "e.chat_id = $1";
  if (args.fromSeq !== undefined) {
    params.push(args.fromSeq);
    where += ` AND e.seq >= $${params.length}`;
  }
  if (args.toSeq !== undefined) {
    params.push(args.toSeq);
    where += ` AND e.seq <= $${params.length}`;
  }
  const ascending = args.fromSeq !== undefined || args.toSeq !== undefined;
  const res = await pool.query<{
    seq: string;
    type: string;
    payload: Record<string, unknown>;
    created_at: Date;
  }>(
    `SELECT e.seq, e.type, e.payload, e.created_at
     FROM thread_events e
     WHERE ${where}
     ORDER BY e.seq ${ascending ? "ASC" : "DESC"}
     LIMIT ${MAX_READ_EVENTS + 1}`,
    params,
  );
  const truncated = res.rows.length > MAX_READ_EVENTS;
  let rows = truncated ? res.rows.slice(0, MAX_READ_EVENTS) : res.rows;
  if (!ascending) rows = [...rows].reverse();
  let used = 0;
  const events: AgentConversationRead["events"] = [];
  for (const row of rows) {
    const text = clip(eventText(row.type, row.payload));
    const room = MAX_READ_CHARS - used;
    if (room <= 0) break;
    const clipped = clip(text, Math.min(MAX_EVENT_CHARS, room));
    used += clipped.length;
    events.push({
      seq: Number(row.seq),
      type: row.type,
      ts: row.created_at.toISOString(),
      text: clipped,
    });
  }
  return { thread_id: args.threadId, thread_title: thread.title, events, truncated };
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
  const tools: ToolRegistration[] = [];

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
          return { structuredOutput: result as unknown as JsonValue };
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
          const hits = await searchAgentConversations(deps.store, deps.agent.id, query, args.limit);
          return { structuredOutput: { hits } as unknown as JsonValue };
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
            return { structuredOutput: result as unknown as JsonValue };
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
          return { structuredOutput: { routines } as unknown as JsonValue };
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
            return { structuredOutput: routine as unknown as JsonValue };
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
            return { structuredOutput: routine as unknown as JsonValue };
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
              structuredOutput: { deleted: true, routine_id: args.routine_id } as unknown as JsonValue,
            };
          } catch (error) {
            return textErr(error instanceof Error ? error.message : String(error));
          }
        },
      }),
    );
  }

  if (allowed.has("delegate") && deps.delegation?.can_spawn === true) {
    tools.push(createDelegateTool(deps.delegation));
  }

  if (allowed.has("release_artifacts") && deps.delegation !== undefined) {
    tools.push(createReleaseArtifactsTool(deps.delegation));
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
          const read = await readAgentConversation(deps.pool, deps.agent.id, {
            threadId: args.thread_id,
            fromSeq: args.from_seq,
            toSeq: args.to_seq,
          });
          if (read === null) return textErr("not_found");
          return { structuredOutput: read as unknown as JsonValue };
        },
      }),
    );
  }

  return tools;
}

