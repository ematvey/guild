import { readWorkerCoordination } from "./store/coordination.js";
import { uuidv5 } from "../platform/time.js";
// Subagent tree tools: one grantable group that spawns child threads and
// sends, reads, lists, cancels and closes them. A spawn returns at once; the
// child reports back by ending its turn.

import { Type } from "typebox";
import { defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import type { PlatformPool } from "../platform/db.js";
import type { ChatStore } from "../platform/store/chats.js";
import type { IdentityStore, UserRow } from "../platform/store/identity.js";
import { ChildLimitReached, type AgentStore } from "./store.js";
import type { ThreadStore } from "../platform/store/thread.js";
import { startThreadRun, ThreadRunRefused, ThreadRunSubmitFailed } from "./thread-run.js";
import { readThreadTranscript } from "./thread-read.js";
import { notifySubagentTree } from "./tree.js";
import type { Agent, AgentRun, AgentThread } from "./types.js";
import { noticeEntry } from "../chats/notice.js";
import type { EntryDraft } from "@earendil-works/pi-durable";
import { structured } from "../harness/tool-schema.js";

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
      entry?: { kind: string };
    },
  ): Promise<number>;
  /** Writes an entry into another chat's conversation. */
  writeEntry(chatId: string, entry: EntryDraft): Promise<void>;
  /** Stops the chat's in-flight turn. */
  stopChat(chatId: string): Promise<void>;
  /** True when this process can stop that chat's turn. A worker owns one
   *  chat and cannot stop a turn in any other. */
  canStopChat(chatId: string): boolean;
}

export interface SubagentsToolContext {
  pool: PlatformPool;
  store: AgentStore;
  threads: ThreadStore;
  /** The calling agent (the parent). */
  agent: Agent;
  /** The caller's own thread. */
  threadId: string;
  /** The caller's current run: the chat's running run, read when a tool
   *  runs (the run's row opens before its first model request). */
  parentRun(): Promise<AgentRun>;
  requester: UserRow;
  runtime: SubagentsRuntime;
  /** Tree limits from config (never constants in this module). */
  maxDepth: number;
  maxChildrenPerNode: number;
  coordination?: { sourceInputId?: string; managed: boolean; actionKey?: string };
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

/** Resolves a spawn reference (an agent id or name) among the agents the
 *  requester can see. A name several visible agents share resolves to the
 *  requester's own agent when there is one, and is otherwise ambiguous. */
export async function resolveSpawnTarget(store: AgentStore, requester: UserRow, reference: string): Promise<Agent> {
  const ref = reference.trim();
  if (ref === "") throw new SubagentError("invalid_target", "agent must not be empty");
  const candidates = await store.findVisible(requester, ref);
  const own = candidates.filter((agent) => agent.owner_user_id === requester.id);
  const pick = candidates.length === 1 ? candidates[0] : own.length === 1 ? own[0] : undefined;
  if (pick === undefined && candidates.length > 1) {
    throw new SubagentError(
      "ambiguous_target",
      "several agents have this name; call list_agents and pass the agent's id",
    );
  }
  if (pick === undefined) {
    throw new SubagentError(
      "target_not_found",
      "no such agent in this organization; call list_agents first to see the agents you can use",
    );
  }
  if (pick.status !== "active") {
    throw new SubagentError(
      "target_unavailable",
      "target agent is not active; call list_agents first to see the agents you can use",
    );
  }
  return pick;
}

/** The reads that resolve a run's owner. */
export interface RequesterReads {
  chats: Pick<ChatStore, "ownerOf">;
  identity: Pick<IdentityStore, "getUser">;
}

/** The run owner: the user who owns the chat behind the current thread;
 *  null when the chat or its owner is gone. */
export async function requesterForChat(reads: RequesterReads, chatId: string): Promise<UserRow | null> {
  const owner = await reads.chats.ownerOf(chatId);
  if (owner === null) return null;
  return reads.identity.getUser(owner.user_id).catch(() => null);
}

/** Resolves the target agent and checks that the requester may use it. */
export async function authorizeSpawn(args: {
  pool: PlatformPool;
  store: AgentStore;
  agent: Agent;
  requester: UserRow;
  targetRef: string;
}): Promise<Agent> {
  const target = await resolveSpawnTarget(args.store, args.requester, args.targetRef);
  const access = await args.store.access(args.requester, target);
  if (!access.can_use) {
    throw new SubagentError("forbidden", "the requester cannot use the target agent");
  }
  return target;
}

/** The caller's own thread id; spawn and the tree tools need the node. */
function callerThreadId(context: SubagentsToolContext): string {
  return context.threadId;
}

/** Resolves a strictly descendant thread. `open` also rejects a closed
 *  node; send needs that, read and the tree lifecycle tools do not. */
async function childThread(
  context: SubagentsToolContext,
  threadId: string,
  options: { open?: boolean } = {},
): Promise<AgentThread> {
  const rootId = callerThreadId(context);
  const thread = await context.store.threads.threadById(threadId);
  if (thread === null) throw new SubagentError("not_found", "no such thread");
  if (thread.id === rootId) {
    throw new SubagentError("not_descendant", "a thread cannot target itself");
  }
  const nodes = await context.store.tree.subtree(rootId);
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

/** Starts one delegated run in a child thread as the run's user, who must
 *  still be able to use the target agent. Refusals and submit failures
 *  surface as tool errors. */
async function startDelegatedRun(
  context: SubagentsToolContext,
  thread: AgentThread,
  agentId: string,
  content: string,
  failureCode: string,
): Promise<{ run: AgentRun; agent: Agent }> {
  const parentRun = await context.parentRun();
  try {
    return await startThreadRun(context, {
      agentId,
      thread,
      requester: context.requester,
      content,
      failureCode,
      recordStack: true,
      run: {
        ...(context.coordination?.actionKey === undefined
          ? {}
          : { id: uuidv5(agentId, context.coordination.actionKey) }),
        user_id: parentRun.user_id ?? context.requester.id,
        parent_run_id: parentRun.id,
        delegate_agent_id: agentId,
        depth: thread.depth,
        trigger: "delegation",
      },
    });
  } catch (error) {
    if (error instanceof ThreadRunRefused) throw new SubagentError(error.code, error.message);
    if (error instanceof ThreadRunSubmitFailed) throw new SubagentError("submit_failed", error.message);
    throw error;
  }
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
  const parentThread = await context.store.threads.threadById(parentThreadId);
  if (parentThread === null) throw new SubagentError("no_parent_thread", "the calling thread is gone");
  if (parentThread.closed_at !== null) throw new SubagentError("closed_thread", "the calling thread is closed");
  if (parentThread.depth >= context.maxDepth) {
    throw new SubagentError(
      "depth_limit",
      `a child at depth ${parentThread.depth + 1} would exceed the depth limit of ${context.maxDepth}`,
    );
  }
  const children = await context.store.tree.childCount(parentThreadId);
  if (context.coordination?.actionKey === undefined && children >= context.maxChildrenPerNode) {
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
  const title = requestedName === "" ? `Spawned: ${task.split(/\r?\n/)[0]!.slice(0, 80)}` : requestedName;
  const titleLocked = requestedName !== "";
  const userId = (await context.parentRun()).user_id ?? context.requester.id;
  let thread: AgentThread;
  try {
    thread = await context.store.threads.createChildThread(
      parentThreadId,
      target.id,
      userId,
      title,
      titleLocked,
      context.maxChildrenPerNode,
      context.coordination,
    );
  } catch (error) {
    if (error instanceof ChildLimitReached) throw new SubagentError("child_limit", error.message);
    throw error;
  }
  const { run: childRun } = await startDelegatedRun(context, thread, target.id, task, "spawn_submit_failed");
  await context.threads.appendEvent(
    parentThread.chat_id,
    {
      type: "child_spawned",
      thread_id: thread.id,
      run_id: childRun.id,
      chat_id: thread.chat_id,
      agent_name: target.name,
      title: thread.title ?? title,
      status: "running",
      task,
    },
    context.coordination?.actionKey === undefined ? undefined : uuidv5(childRun.id, "spawn-display"),
  );
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
  const { run, agent: target } = await startDelegatedRun(context, thread, thread.agent_id, text, "send_submit_failed");
  // The row lives in the child's own parent chat, whichever ancestor sent
  // the message: the child's result is delivered there, so a row written in
  // the caller's chat would never receive one. In the caller's own chat the
  // row shows the caller's tool call. Sent from further up, it is a notice
  // in the parent's conversation: that agent made no call, so it reads the
  // turn its child was given before the child's result arrives.
  const parentThreadId = thread.parent_thread_id ?? callerThreadId(context);
  const rowThread = await context.store.threads.threadById(parentThreadId);
  if (rowThread !== null) {
    const event = {
      type: "child_spawned" as const,
      thread_id: thread.id,
      run_id: run.id,
      chat_id: thread.chat_id,
      agent_name: target.name,
      title: thread.title ?? "",
      status: "running",
      task: text,
    };
    if (parentThreadId === callerThreadId(context)) {
      await context.threads.appendEvent(rowThread.chat_id, event);
    } else {
      await context.runtime.writeEntry(
        rowThread.chat_id,
        noticeEntry(
          `An ancestor thread sent your child thread ${thread.id} ("${thread.title ?? ""}", agent ${target.name}) a new turn: ${text}`,
          event,
        ),
      );
    }
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
  const agents = (await context.store.list(context.requester)).filter(
    (agent) => !agent.is_personal || agent.owner_user_id === context.requester.id,
  );
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
  const children = await context.store.tree.childThreadSummaries(rootId);
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
  const active = await context.store.tree.activeRunsInSubtree(threadId);
  const cancelled = await context.store.tree.cancelSubtree(threadId);
  for (const chatId of new Set(active.map((run) => run.chat_id))) {
    if (!context.runtime.canStopChat(chatId)) continue;
    await context.runtime.stopChat(chatId);
  }
  return cancelled;
}

/** Stops in-flight turns in the subtree. The nodes stay addressable. */
export async function cancelThread(
  context: Pick<SubagentsToolContext, "store" | "runtime" | "pool">,
  threadId: string,
): Promise<CancelResult> {
  const cancelled = await stopSubtree(context, threadId);
  await notifySubagentTree(context.pool, threadId);
  return { thread_id: threadId, cancelled };
}

/** Cancels the subtree and stamps closed_at on every node. Rows and
 *  attachments stay, and deliveries stop. */
export async function closeThread(
  context: Pick<SubagentsToolContext, "store" | "runtime" | "pool">,
  threadId: string,
): Promise<CloseResult> {
  const cancelled = await stopSubtree(context, threadId);
  const closed = await context.store.tree.closeSubtree(threadId);
  await notifySubagentTree(context.pool, threadId);
  return { thread_id: threadId, closed, cancelled };
}

/** Cancels the subtree rooted at a child the caller owns. */
export async function cancel(context: SubagentsToolContext, args: { thread_id: string }): Promise<CancelResult> {
  const thread = await childThread(context, args.thread_id);
  return cancelThread(context, thread.id);
}

/** Closes the subtree rooted at a child the caller owns. */
export async function close(context: SubagentsToolContext, args: { thread_id: string }): Promise<CloseResult> {
  const thread = await childThread(context, args.thread_id);
  return closeThread(context, thread.id);
}

/** Builds the subagent context of an agent thread's chat; null for a chat
 *  with no agent thread or no requester. */
export async function subagentsContextForChat(
  args: RequesterReads & {
    pool: PlatformPool;
    store: AgentStore;
    threads: ThreadStore;
    agent: Agent;
    chatId: string;
    runtime: SubagentsRuntime;
    maxDepth: number;
    maxChildrenPerNode: number;
  },
): Promise<SubagentsToolContext | null> {
  const thread = await args.store.threads.threadByChatId(args.chatId);
  if (thread === null) return null;
  const requester = await requesterForChat(args, args.chatId);
  if (requester === null) return null;
  const policy = (
    await readWorkerCoordination<{ coordinator_managed: boolean; source_input_id: string | null }>(args.pool, [
      thread.id,
    ])
  ).rows[0];
  return {
    ...(policy?.coordinator_managed
      ? {
          coordination: {
            managed: true,
            ...(policy.source_input_id === null ? {} : { sourceInputId: policy.source_input_id }),
          },
        }
      : {}),
    pool: args.pool,
    store: args.store,
    threads: args.threads,
    agent: args.agent,
    threadId: thread.id,
    parentRun: async () => {
      const run = await args.store.runs.runningRunForChat(args.chatId);
      if (run === null) throw new SubagentError("no_running_run", "the calling thread has no running run");
      return run;
    },
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
        "run and chat ids at once; the child reports back by ending its turn. Do not wait or poll for the child, " +
        "and do not sleep. Read it with read_thread only when you need its progress for a decision. Continue your " +
        "own work or end your turn; the result arrives as a new message. Depth and child count limits come from the " +
        "deployment config. Call list_agents first when the target is uncertain; each entry's description says what " +
        "that agent is for.",
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
          return { structuredOutput: structured(await spawn(context, args)) };
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
          return { structuredOutput: structured(await send(context, args)) };
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
          return { structuredOutput: structured({ agents: await listAgents(context) }) };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
    defineTool({
      name: "read_thread",
      description: "Read a bounded transcript excerpt from a child thread (max 200 events, 20k chars).",
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
          return { structuredOutput: structured(await read(context, args)) };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
    defineTool({
      name: "list",
      description: "List the direct children of this thread with their latest run status, depth and elapsed time.",
      parameters: Type.Object({}),
      structuredOutputSchema: listOutput,
      replay: "safe",
      callers: ["tools"],
      outputLimits: { maxBytes: 32 * 1024 },
      execute: async () => {
        try {
          return { structuredOutput: structured({ children: await list(context) }) };
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
          return { structuredOutput: structured(await cancel(context, args)) };
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
          return { structuredOutput: structured(await close(context, args)) };
        } catch (error) {
          return errorResult(error);
        }
      },
    }),
  ];
}
