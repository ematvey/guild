// Subagent tree tools: one grantable group that spawns child threads and
// sends, reads, lists, cancels and closes them. A spawn returns at once; the
// child reports back by ending its turn.

import { Type } from "typebox";
import type { JsonValue } from "@earendil-works/chord";
import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { PlatformPool } from "../platform/db.js";
import type { UserRow } from "../platform/store/identity.js";
import { isUuid, uuidv7 } from "../platform/time.js";
import type { AgentStore } from "./store.js";
import type { ThreadStore } from "../platform/store/thread.js";
import { userMessageEvent } from "../platform/domain/thread-events.js";
import { readThreadTranscript } from "./thread-read.js";
import type { Agent, AgentRun, AgentThread } from "./types.js";

export interface SubagentsRuntime {
  /** Posts a turn into the child thread's chat. */
  submitTurn(
    chatId: string,
    orgId: string,
    input: {
      orgId: string;
      requestId: string;
      content: string;
      images: { mimeType: string; data: string }[];
      model: string | null;
    },
  ): Promise<number>;
  /** Stops the chat's in-flight turn. */
  stopChat(chatId: string): Promise<void>;
  /** True when this process can stop that chat's turn. A worker owns one
   *  chat; another chat needs the remoteStop IPC that does not exist yet. */
  canStopChat(chatId: string): boolean;
}

export interface SubagentsToolContext {
  pool: PlatformPool;
  store: AgentStore;
  threads: ThreadStore;
  /** The calling agent (the parent). */
  agent: Agent;
  parentRun: AgentRun;
  requester: UserRow;
  runtime: SubagentsRuntime;
  /** Tree limits from config (never constants in this module). */
  maxDepth: number;
  maxChildrenPerNode: number;
}

/** Longest spawner-chosen session name. */
export const MAX_CHILD_NAME_CHARS = 80;

export class SubagentError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Resolves the target by id or exact case-insensitive name within the
 *  caller's org. Missing, foreign-org and archived agents are one error. */
export async function resolveSpawnTarget(
  pool: PlatformPool,
  orgId: string,
  reference: string,
): Promise<Agent> {
  const ref = reference.trim();
  if (ref === "") throw new SubagentError("invalid_target", "agent must not be empty");
  const params: unknown[] = [orgId, ref];
  const where = isUuid(ref)
    ? "a.org_id = $1 AND a.id = $2"
    : "a.org_id = $1 AND lower(a.name) = lower($2)";
  const res = await pool.query<Record<string, unknown>>(
    `SELECT a.id, a.org_id, a.owner_user_id, a.name, a.description, a.model, a.tools_mode,
            a.is_personal,
            (SELECT r.alias FROM model_routes r WHERE r.org_id = a.org_id AND r.model = a.model LIMIT 1) AS model_alias,
            a.tools, a.visibility, a.resources, a.status,
            to_char(a.deleted_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS deleted_at,
            to_char(a.purge_after AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS purge_after,
            to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
            to_char(a.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at
     FROM agents a WHERE ${where}
     ORDER BY a.created_at ASC, a.id ASC LIMIT 1`,
    params,
  );
  const row = res.rows[0];
  if (row === undefined) {
    throw new SubagentError(
      "target_not_found",
      "no such agent in this organization; call list_agents first to see the agents you can use",
    );
  }
  if (row.status !== "active") {
    throw new SubagentError(
      "target_unavailable",
      "target agent is not active; call list_agents first to see the agents you can use",
    );
  }
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    owner_user_id: row.owner_user_id as string,
    name: row.name as string,
    description: (row.description as string | null) ?? "",
    model: row.model as string,
    model_alias: (row.model_alias as string | null) ?? null,
    is_personal: Boolean(row.is_personal),
    tools: (row.tools as Agent["tools"] | null) ?? [],
    tools_mode: (row.tools_mode as Agent["tools_mode"] | null) ?? "selected",
    visibility: row.visibility as Agent["visibility"],
    resources: (row.resources as Record<string, unknown> | null) ?? {},
    status: row.status as Agent["status"],
    deleted_at: (row.deleted_at as string | null) ?? null,
    purge_after: (row.purge_after as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

/** The run owner: the user who owns the chat behind the current thread. */
export async function requesterForChat(pool: PlatformPool, chatId: string): Promise<UserRow | null> {
  const res = await pool.query<{
    id: string;
    org_id: string;
    email: string;
    role: string;
    identity_type: string;
    display_name: string | null;
    avatar_url: string | null;
    onboarded_at: Date | null;
  }>(
    `SELECT u.id, u.org_id, u.email, u.role, u.identity_type, u.display_name, u.avatar_url, u.onboarded_at
     FROM chats c JOIN users u ON u.id = c.user_id WHERE c.id = $1`,
    [chatId],
  );
  const row = res.rows[0];
  return row === undefined ? null : { ...row, onboarded_at: row.onboarded_at ?? null };
}

/** Resolves the target agent and checks that the requester may use it. */
export async function authorizeSpawn(args: {
  pool: PlatformPool;
  store: AgentStore;
  agent: Agent;
  requester: UserRow;
  targetRef: string;
}): Promise<Agent> {
  const target = await resolveSpawnTarget(args.pool, args.agent.org_id, args.targetRef);
  const access = await args.store.access(args.requester, target);
  if (!access.can_use) {
    throw new SubagentError("forbidden", "the requester cannot use the target agent");
  }
  return target;
}

/** The caller's own thread id; spawn and the tree tools need the node. */
function callerThreadId(context: SubagentsToolContext): string {
  if (context.parentRun.thread_id === null) {
    throw new SubagentError("no_parent_thread", "the calling run has no thread");
  }
  return context.parentRun.thread_id;
}

/** Resolves a strictly descendant thread. `open` also rejects a closed
 *  node; send needs that, read and the tree lifecycle tools do not. */
async function childThread(
  context: SubagentsToolContext,
  threadId: string,
  options: { open?: boolean } = {},
): Promise<AgentThread> {
  const rootId = callerThreadId(context);
  const thread = await context.store.threadById(threadId);
  if (thread === null) throw new SubagentError("not_found", "no such thread");
  if (thread.id === rootId) {
    throw new SubagentError("not_descendant", "a thread cannot target itself");
  }
  const nodes = await context.store.subtree(rootId);
  if (!nodes.some((node) => node.id === thread.id)) {
    throw new SubagentError("not_descendant", "the thread is not in this thread's subtree");
  }
  if (options.open === true && thread.closed_at !== null) {
    throw new SubagentError("closed_thread", "the thread is closed");
  }
  return thread;
}

export interface SpawnResult {
  thread_id: string;
  run_id: string;
  chat_id: string;
  title: string;
  agent_name: string;
  status: "running";
}

export interface SendResult {
  thread_id: string;
  run_id: string;
  chat_id: string;
  title: string;
  agent_name: string;
  status: "running";
}

export interface AgentDirectoryEntry {
  id: string;
  name: string;
  description: string;
  personal: boolean;
}

export interface ChildListEntry {
  thread_id: string;
  agent_id: string;
  agent_name: string;
  title: string;
  status: string | null;
  depth: number;
  closed: boolean;
  started_at: string | null;
  elapsed_ms: number | null;
}

export interface CancelResult {
  thread_id: string;
  cancelled: number;
}

export interface CloseResult {
  thread_id: string;
  closed: number;
  cancelled: number;
}

/** Creates the child thread and its first run, posts the task turn, and
 *  returns immediately. It never waits for the child and copies no files. */
export async function spawn(
  context: SubagentsToolContext,
  args: { agent: string; task: string; name?: string },
): Promise<SpawnResult> {
  const task = args.task.trim();
  if (task === "") throw new SubagentError("invalid_task", "task must not be empty");
  const requestedName = (args.name ?? "").trim();
  if (requestedName.length > MAX_CHILD_NAME_CHARS) {
    throw new SubagentError("invalid_name", `name must be at most ${MAX_CHILD_NAME_CHARS} characters`);
  }
  const parentThreadId = callerThreadId(context);
  const parentThread = await context.store.threadById(parentThreadId);
  if (parentThread === null) throw new SubagentError("no_parent_thread", "the calling thread is gone");
  if (parentThread.closed_at !== null) throw new SubagentError("closed_thread", "the calling thread is closed");
  if (parentThread.depth >= context.maxDepth) {
    throw new SubagentError(
      "depth_limit",
      `a child at depth ${parentThread.depth + 1} would exceed the depth limit of ${context.maxDepth}`,
    );
  }
  const children = await context.store.childCount(parentThreadId);
  if (children >= context.maxChildrenPerNode) {
    throw new SubagentError(
      "child_limit",
      `this thread already has ${children} children; the limit is ${context.maxChildrenPerNode} per thread`,
    );
  }
  const target = await authorizeSpawn({
    pool: context.pool,
    store: context.store,
    agent: context.agent,
    requester: context.requester,
    targetRef: args.agent,
  });
  // The spawner names the session; without one the task's first line is the
  // fallback label. The title is locked when the spawner chose it.
  const title =
    requestedName === "" ? `Spawned: ${task.split(/\r?\n/)[0]!.slice(0, 80)}` : requestedName;
  const titleLocked = requestedName !== "";
  const userId = context.parentRun.user_id ?? context.requester.id;
  const thread = await context.store.createChildThread(parentThreadId, target.id, userId, title, titleLocked);
  const childRun = await context.store.createRun({
    agent_id: target.id,
    user_id: userId,
    thread_id: thread.id,
    parent_run_id: context.parentRun.id,
    delegate_agent_id: target.id,
    depth: thread.depth,
    trigger: "delegation",
    status: "running",
    started_at: new Date().toISOString(),
  });
  try {
    await context.threads.appendEvent(thread.chat_id, userMessageEvent(task));
    await context.runtime.submitTurn(thread.chat_id, target.org_id, {
      orgId: target.org_id,
      requestId: uuidv7(),
      content: task,
      images: [],
      model: target.model,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await context.store
      .updateRun(childRun.id, {
        status: "failed",
        error_code: "spawn_submit_failed",
        error_message: error instanceof Error && error.stack ? `${message}\n${error.stack}` : message,
        finished_at: new Date().toISOString(),
      })
      .catch(() => {});
    throw new SubagentError("submit_failed", message);
  }
  await context.threads.appendEvent(parentThread.chat_id, {
    type: "child_spawned",
    thread_id: thread.id,
    run_id: childRun.id,
    chat_id: thread.chat_id,
    agent_name: target.name,
    title: thread.title ?? title,
    status: "running",
    task,
  });
  return {
    thread_id: thread.id,
    run_id: childRun.id,
    chat_id: thread.chat_id,
    title: thread.title ?? title,
    agent_name: target.name,
    status: "running",
  };
}

/** Posts one turn into a descendant thread. The thread must be open. */
export async function send(
  context: SubagentsToolContext,
  args: { thread_id: string; text: string },
): Promise<SendResult> {
  const text = args.text.trim();
  if (text === "") throw new SubagentError("invalid_text", "text must not be empty");
  const thread = await childThread(context, args.thread_id, { open: true });
  const target = await context.store.fetchAgent(thread.agent_id);
  const userId = context.parentRun.user_id ?? context.requester.id;
  const run = await context.store.createRun({
    agent_id: target.id,
    user_id: userId,
    thread_id: thread.id,
    parent_run_id: context.parentRun.id,
    delegate_agent_id: target.id,
    depth: thread.depth,
    trigger: "delegation",
    status: "running",
    started_at: new Date().toISOString(),
  });
  try {
    await context.threads.appendEvent(thread.chat_id, userMessageEvent(text));
    await context.runtime.submitTurn(thread.chat_id, target.org_id, {
      orgId: target.org_id,
      requestId: uuidv7(),
      content: text,
      images: [],
      model: target.model,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await context.store
      .updateRun(run.id, {
        status: "failed",
        error_code: "send_submit_failed",
        error_message: error instanceof Error && error.stack ? `${message}\n${error.stack}` : message,
        finished_at: new Date().toISOString(),
      })
      .catch(() => {});
    throw new SubagentError("submit_failed", message);
  }
  const parentThread = await context.store.threadById(callerThreadId(context));
  if (parentThread !== null) {
    await context.threads.appendEvent(parentThread.chat_id, {
      type: "child_spawned",
      thread_id: thread.id,
      run_id: run.id,
      chat_id: thread.chat_id,
      agent_name: target.name,
      title: thread.title ?? "",
      status: "running",
      task: text,
    });
  }
  return {
    thread_id: thread.id,
    run_id: run.id,
    chat_id: thread.chat_id,
    title: thread.title ?? "",
    agent_name: target.name,
    status: "running",
  };
}

/** The directory the caller's user may use: every non-personal agent visible
 *  to that user plus their own personal agent, sorted by name. */
export async function listAgents(context: SubagentsToolContext): Promise<AgentDirectoryEntry[]> {
  const agents = await context.store.list(context.requester);
  return agents
    .map((agent) => ({
      id: agent.id,
      name: agent.name,
      description: agent.description,
      personal: agent.is_personal,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Bounded excerpt of a descendant thread, same limits as
 *  conversation_read. */
export async function read(
  context: SubagentsToolContext,
  args: { thread_id: string; from_seq?: number; to_seq?: number },
): Promise<Awaited<ReturnType<typeof readThreadTranscript>>> {
  const thread = await childThread(context, args.thread_id);
  return readThreadTranscript(context.pool, {
    threadId: thread.id,
    chatId: thread.chat_id,
    title: thread.title,
    ...(args.from_seq === undefined ? {} : { fromSeq: args.from_seq }),
    ...(args.to_seq === undefined ? {} : { toSeq: args.to_seq }),
  });
}

/** Direct children of the calling thread with their latest run status. */
export async function list(context: SubagentsToolContext): Promise<ChildListEntry[]> {
  const rootId = callerThreadId(context);
  const children = await context.store.childThreadSummaries(rootId);
  const now = Date.now();
  return children.map((child) => {
    const start = child.started_at === null ? null : Date.parse(child.started_at);
    const end = child.finished_at === null ? now : Date.parse(child.finished_at);
    return {
      thread_id: child.thread.id,
      agent_id: child.thread.agent_id,
      agent_name: child.agent_name,
      title: child.thread.title,
      status: child.status,
      depth: child.thread.depth,
      closed: child.thread.closed_at !== null,
      started_at: child.started_at,
      elapsed_ms: start === null || Number.isNaN(start) ? null : Math.max(0, end - start),
    };
  });
}

/** Stops the in-flight turns of a subtree and cancels their runs. A turn
 *  owned by another worker cannot be interrupted from here: its run is
 *  cancelled in the store, and delivery drops a cancelled run's result, so
 *  the parent sees a cancelled child either way. */
async function stopSubtree(
  context: Pick<SubagentsToolContext, "store" | "runtime">,
  threadId: string,
): Promise<number> {
  const active = await context.store.activeRunsInSubtree(threadId);
  const cancelled = await context.store.cancelSubtree(threadId);
  for (const chatId of new Set(active.map((run) => run.chat_id))) {
    if (!context.runtime.canStopChat(chatId)) continue;
    await context.runtime.stopChat(chatId);
  }
  return cancelled;
}

/** Stops in-flight turns in the subtree. The nodes stay addressable. */
export async function cancelThread(
  context: Pick<SubagentsToolContext, "store" | "runtime">,
  threadId: string,
): Promise<CancelResult> {
  return { thread_id: threadId, cancelled: await stopSubtree(context, threadId) };
}

/** Cancels the subtree and stamps closed_at on every node. Rows and
 *  attachments stay, and deliveries stop. */
export async function closeThread(
  context: Pick<SubagentsToolContext, "store" | "runtime">,
  threadId: string,
): Promise<CloseResult> {
  const cancelled = await stopSubtree(context, threadId);
  const closed = await context.store.closeSubtree(threadId);
  return { thread_id: threadId, closed, cancelled };
}

/** Cancels the subtree rooted at a child the caller owns. */
export async function cancel(
  context: SubagentsToolContext,
  args: { thread_id: string },
): Promise<CancelResult> {
  const thread = await childThread(context, args.thread_id);
  return cancelThread(context, thread.id);
}

/** Closes the subtree rooted at a child the caller owns. */
export async function close(
  context: SubagentsToolContext,
  args: { thread_id: string },
): Promise<CloseResult> {
  const thread = await childThread(context, args.thread_id);
  return closeThread(context, thread.id);
}

/** Builds the per-run subagent context; null when the chat has no running
 *  run (plain chats and turns before admission). */
export async function subagentsContextForChat(args: {
  pool: PlatformPool;
  store: AgentStore;
  threads: ThreadStore;
  agent: Agent;
  chatId: string;
  runtime: SubagentsRuntime;
  maxDepth: number;
  maxChildrenPerNode: number;
}): Promise<SubagentsToolContext | null> {
  const parentRun = await args.store.runningRunForChat(args.chatId);
  if (parentRun === null) return null;
  const requester = await requesterForChat(args.pool, args.chatId);
  if (requester === null) return null;
  return {
    pool: args.pool,
    store: args.store,
    threads: args.threads,
    agent: args.agent,
    parentRun,
    requester,
    runtime: args.runtime,
    maxDepth: args.maxDepth,
    maxChildrenPerNode: args.maxChildrenPerNode,
  };
}

const textErr = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

function errorResult(error: unknown): ToolExecutionResult {
  const code = error instanceof SubagentError ? error.code : "subagent_failed";
  const message = error instanceof Error ? error.message : String(error);
  return textErr(JSON.stringify({ error: code, message }));
}

const spawnOutput = Type.Object({
  thread_id: Type.String(),
  run_id: Type.String(),
  chat_id: Type.String(),
  title: Type.String(),
  agent_name: Type.String(),
  status: Type.String(),
});

const sendOutput = Type.Object({
  thread_id: Type.String(),
  run_id: Type.String(),
  chat_id: Type.String(),
  title: Type.String(),
  agent_name: Type.String(),
  status: Type.String(),
});

const directoryOutput = Type.Object({
  agents: Type.Array(
    Type.Object({
      id: Type.String(),
      name: Type.String(),
      description: Type.String(),
      personal: Type.Boolean(),
    }),
  ),
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

const listOutput = Type.Object({
  children: Type.Array(
    Type.Object({
      thread_id: Type.String(),
      agent_id: Type.String(),
      agent_name: Type.String(),
      title: Type.String(),
      status: Type.Union([Type.String(), Type.Null()]),
      depth: Type.Number(),
      closed: Type.Boolean(),
      started_at: Type.Union([Type.String(), Type.Null()]),
      elapsed_ms: Type.Union([Type.Number(), Type.Null()]),
    }),
  ),
});

const cancelOutput = Type.Object({
  thread_id: Type.String(),
  cancelled: Type.Number(),
});

const closeOutput = Type.Object({
  thread_id: Type.String(),
  closed: Type.Number(),
  cancelled: Type.Number(),
});

/** The six tree tools as one group. */
export function createSubagentTools(context: SubagentsToolContext): ToolRegistration[] {
  return [
    defineTool({
      name: "spawn",
      description:
        "Spawn a child agent thread and post its first task. Give the session a short `name`: it labels the row the " +
        "user sees and the child thread itself, so several children stay distinguishable. Returns the child thread, " +
        "run and chat ids at once; the child reports back by ending its turn. Depth and child count limits come from " +
        "the deployment config. Call list_agents first when the target name is uncertain.",
      parameters: Type.Object({
        agent: Type.String({ description: "Target agent id or exact name within this organization" }),
        name: Type.Optional(
          Type.String({
            description: `Short session name the row and the child thread show, at most ${MAX_CHILD_NAME_CHARS} characters`,
          }),
        ),
        task: Type.String({ description: "The task for the child agent" }),
      }),
      structuredOutputSchema: spawnOutput,
      replay: "unsafe",
      callers: ["tools"],
      outputLimits: { maxBytes: 16 * 1024 },
      execute: async (args) => {
        try {
          return { structuredOutput: (await spawn(context, args)) as unknown as JsonValue };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
    defineTool({
      name: "send",
      description:
        "Post a message as a new turn into a child thread you spawned. The thread must be open and in your subtree.",
      parameters: Type.Object({
        thread_id: Type.String({ description: "The child thread id" }),
        text: Type.String({ description: "The message to post" }),
      }),
      structuredOutputSchema: sendOutput,
      replay: "unsafe",
      callers: ["tools"],
      outputLimits: { maxBytes: 16 * 1024 },
      execute: async (args) => {
        try {
          return { structuredOutput: (await send(context, args)) as unknown as JsonValue };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
    defineTool({
      name: "list_agents",
      description:
        "List the agents you may spawn by name: every non-personal agent visible to your user plus your own " +
        "personal agent. Each entry carries id, name, description and the personal flag.",
      parameters: Type.Object({}),
      structuredOutputSchema: directoryOutput,
      replay: "safe",
      callers: ["tools"],
      outputLimits: { maxBytes: 32 * 1024 },
      execute: async () => {
        try {
          return { structuredOutput: { agents: await listAgents(context) } as unknown as JsonValue };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
    defineTool({
      name: "read_thread",
      description:
        "Read a bounded transcript excerpt from a child thread (max 200 events, 20k chars).",
      parameters: Type.Object({
        thread_id: Type.String({ description: "The child thread id" }),
        from_seq: Type.Optional(Type.Number({ description: "First event seq to include" })),
        to_seq: Type.Optional(Type.Number({ description: "Last event seq to include" })),
      }),
      structuredOutputSchema: readOutput,
      replay: "safe",
      callers: ["tools"],
      outputLimits: { maxBytes: 32 * 1024 },
      execute: async (args) => {
        try {
          return { structuredOutput: (await read(context, args)) as unknown as JsonValue };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
    defineTool({
      name: "list",
      description:
        "List the direct children of this thread with their latest run status, depth and elapsed time.",
      parameters: Type.Object({}),
      structuredOutputSchema: listOutput,
      replay: "safe",
      callers: ["tools"],
      outputLimits: { maxBytes: 32 * 1024 },
      execute: async () => {
        try {
          return { structuredOutput: { children: await list(context) } as unknown as JsonValue };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
    defineTool({
      name: "cancel",
      description:
        "Stop the in-flight turns of a child thread and every descendant. The threads stay open and can take new turns.",
      parameters: Type.Object({
        thread_id: Type.String({ description: "The child thread id" }),
      }),
      structuredOutputSchema: cancelOutput,
      replay: "unsafe",
      callers: ["tools"],
      outputLimits: { maxBytes: 8 * 1024 },
      execute: async (args) => {
        try {
          return { structuredOutput: (await cancel(context, args)) as unknown as JsonValue };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
    defineTool({
      name: "close",
      description:
        "Cancel a child thread and every descendant, then archive them. Rows and files stay; deliveries stop.",
      parameters: Type.Object({
        thread_id: Type.String({ description: "The child thread id" }),
      }),
      structuredOutputSchema: closeOutput,
      replay: "unsafe",
      callers: ["tools"],
      outputLimits: { maxBytes: 8 * 1024 },
      execute: async (args) => {
        try {
          return { structuredOutput: (await close(context, args)) as unknown as JsonValue };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
  ];
}
