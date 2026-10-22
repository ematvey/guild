// Agent-to-agent delegation: a child run in the target agent's workspace,
// bounded by depth/child/cycle rules. The parent receives the child's final
// text and the ids of the files the child sent with send_file; nothing is
// copied between workspaces.

import { Type } from "typebox";
import type { JsonValue } from "@earendil-works/chord";
import {
  defineTool,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@earendil-works/pi-durable";
import type { PlatformPool } from "../platform/db.js";
import type { ThreadStore } from "../platform/store/thread.js";
import type { UserRow } from "../platform/store/identity.js";
import { isUuid, uuidv7 } from "../platform/time.js";
import type { AgentStore } from "./store.js";
import type { Agent, AgentRun, AgentRunStatus } from "./types.js";

export const MAX_DELEGATION_DEPTH = 2;
export const MAX_CHILDREN_PER_RUN = 3;
export const DEFAULT_DELEGATION_TIMEOUT_MS = 120_000;
const POLL_MS = 250;
const TERMINAL: ReadonlySet<AgentRunStatus> = new Set(["succeeded", "failed", "silent", "skipped", "cancelled"]);

export interface DelegationRuntime {
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
}

export interface DelegationToolContext {
  pool: PlatformPool;
  store: AgentStore;
  threads: ThreadStore;
  /** The calling agent (the parent). */
  agent: Agent;
  parentRun: AgentRun;
  requester: UserRow;
  runtime: DelegationRuntime;
  timeoutMs: number;
  /** False when depth or child count has removed the delegate tool. */
  can_spawn: boolean;
}

export interface DelegateArgs {
  agent: string;
  task: string;
  context?: string;
}

export interface DelegateResult {
  run_id: string;
  text: string;
  /** Ids of the child's send_file attachments, in send order. */
  attachments: string[];
}

export class DelegationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Resolves the target by id or exact case-insensitive name within the
 *  caller's org. Missing, foreign-org and archived agents are one error. */
export async function resolveDelegationTarget(
  pool: PlatformPool,
  orgId: string,
  reference: string,
): Promise<Agent> {
  const ref = reference.trim();
  if (ref === "") throw new DelegationError("invalid_target", "agent must not be empty");
  const params: unknown[] = [orgId, ref];
  const where = isUuid(ref)
    ? "a.org_id = $1 AND a.id = $2"
    : "a.org_id = $1 AND lower(a.name) = lower($2)";
  const res = await pool.query<Record<string, unknown>>(
    `SELECT a.id, a.org_id, a.owner_user_id, a.name, a.model, a.tools_mode,
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
  if (row === undefined) throw new DelegationError("target_not_found", "no such agent in this organization");
  if (row.status !== "active") throw new DelegationError("target_unavailable", "target agent is not active");
  return {
    id: row.id as string,
    org_id: row.org_id as string,
    owner_user_id: row.owner_user_id as string,
    name: row.name as string,
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

/** Checks the per-run limits and authorization. Returns the target agent. */
export async function authorizeDelegation(args: {
  pool: PlatformPool;
  store: AgentStore;
  agent: Agent;
  parentRun: AgentRun;
  requester: UserRow;
  targetRef: string;
}): Promise<Agent> {
  const target = await resolveDelegationTarget(args.pool, args.agent.org_id, args.targetRef);
  if (target.id === args.agent.id) {
    throw new DelegationError("self_delegation", "an agent cannot delegate to itself");
  }
  if (args.parentRun.depth >= MAX_DELEGATION_DEPTH) {
    throw new DelegationError("depth_limit", `delegation depth is limited to ${MAX_DELEGATION_DEPTH}`);
  }
  const children = await args.store.childCount(args.parentRun.id);
  if (children >= MAX_CHILDREN_PER_RUN) {
    throw new DelegationError("child_limit", `a run may spawn at most ${MAX_CHILDREN_PER_RUN} children`);
  }
  const ancestors = await args.store.ancestorRuns(args.parentRun.id);
  if (ancestors.some((run) => run.agent_id === target.id)) {
    throw new DelegationError("cycle", "delegation would create a cycle");
  }
  const access = await args.store.access(args.requester, target);
  if (!access.can_use) {
    throw new DelegationError("forbidden", "the requester cannot use the target agent");
  }
  return target;
}

function composeTask(parent: AgentRun, args: DelegateArgs): string {
  const parts = [`Task: ${args.task.trim()}`];
  const context = args.context?.trim() ?? "";
  if (context !== "") parts.push(`Context:\n${context}`);
  if (parent.summary !== null && parent.summary.trim() !== "") {
    parts.push(`Parent run summary:\n${parent.summary.trim()}`);
  }
  parts.push("Work only in your own workspace. Return a concise result; use send_file for files the parent should receive.");
  return parts.join("\n\n");
}

async function waitForRun(
  store: AgentStore,
  runId: string,
  timeoutMs: number,
): Promise<AgentRun> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await store.getRun(runId);
    if (TERMINAL.has(run.status)) return run;
    if (Date.now() >= deadline) return run;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

async function assistantText(pool: PlatformPool, run: AgentRun): Promise<string> {
  if (run.thread_id === null) return run.summary ?? "";
  const res = await pool.query<{ payload: Record<string, unknown> }>(
    `SELECT e.payload FROM thread_events e
     JOIN agent_threads t ON t.chat_id = e.chat_id
     WHERE t.id = $1 AND e.type = 'assistant_message'
       AND e.created_at >= COALESCE($2::timestamptz, to_timestamp(0))
     ORDER BY e.seq ASC`,
    [run.thread_id, run.started_at ?? run.created_at],
  );
  const texts: string[] = [];
  for (const row of res.rows) {
    const blocks = Array.isArray(row.payload.blocks) ? (row.payload.blocks as { type?: string; text?: string }[]) : [];
    for (const block of blocks) {
      if (block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
        texts.push(block.text);
      }
    }
  }
  return texts.join("\n\n").trim() || run.summary || "";
}

async function childAttachmentIds(pool: PlatformPool, chatId: string, agentId: string, since: string): Promise<string[]> {
  const res = await pool.query<{ id: string }>(
    `SELECT id FROM attachments
     WHERE chat_id = $1 AND author_kind = 'agent' AND author_id = $2
       AND created_at >= $3::timestamptz
     ORDER BY created_at ASC, id ASC`,
    [chatId, agentId, since],
  );
  return res.rows.map((row) => row.id);
}

/** Creates the child run and thread, submits the isolated task, waits for a
 *  terminal state, then returns the child's final text and sent file ids. */
export async function delegate(context: DelegationToolContext, args: DelegateArgs): Promise<DelegateResult> {
  const task = args.task.trim();
  if (task === "") throw new DelegationError("invalid_task", "task must not be empty");
  if (!context.can_spawn) throw new DelegationError("limit", "this run cannot spawn more delegations");
  const target = await authorizeDelegation({
    pool: context.pool,
    store: context.store,
    agent: context.agent,
    parentRun: context.parentRun,
    requester: context.requester,
    targetRef: args.agent,
  });
  const title = `Delegated: ${task.split(/\r?\n/)[0]!.slice(0, 80)}`;
  const userId = context.parentRun.user_id ?? context.requester.id;
  const thread = await context.store.createThread(target.id, userId, title, "routine_run");
  const childRun = await context.store.createRun({
    agent_id: target.id,
    user_id: userId,
    thread_id: thread.id,
    parent_run_id: context.parentRun.id,
    delegate_agent_id: target.id,
    depth: context.parentRun.depth + 1,
    trigger: "delegation",
    status: "running",
    started_at: new Date().toISOString(),
  });
  try {
    await context.runtime.submitTurn(thread.chat_id, target.org_id, {
      orgId: target.org_id,
      requestId: uuidv7(),
      content: composeTask(context.parentRun, args),
      images: [],
      model: target.model,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await context.store
      .updateRun(childRun.id, {
        status: "failed",
        error_code: "delegation_submit_failed",
        error_message: error instanceof Error && error.stack ? `${message}\n${error.stack}` : message,
        finished_at: new Date().toISOString(),
      })
      .catch(() => {});
    throw new DelegationError("submit_failed", message);
  }
  const finished = await waitForRun(context.store, childRun.id, context.timeoutMs);
  if (!TERMINAL.has(finished.status)) {
    throw new DelegationError("timeout", `delegated run ${childRun.id} did not finish within ${context.timeoutMs} ms`);
  }
  if (finished.status === "failed") {
    throw new DelegationError(
      "child_failed",
      finished.error_message ?? finished.summary ?? `delegated run ${childRun.id} failed`,
    );
  }
  const text = await assistantText(context.pool, finished);
  const attachments = await childAttachmentIds(
    context.pool,
    thread.chat_id,
    target.id,
    childRun.started_at ?? childRun.created_at,
  );
  return { run_id: childRun.id, text, attachments };
}

/** Builds the per-run delegation context; null when the chat has no running
 *  run (plain chats and turns before admission). */
export async function delegationContextForChat(args: {
  pool: PlatformPool;
  store: AgentStore;
  threads: ThreadStore;
  agent: Agent;
  chatId: string;
  runtime: DelegationRuntime;
  timeoutMs?: number;
}): Promise<DelegationToolContext | null> {
  const parentRun = await args.store.runningRunForChat(args.chatId);
  if (parentRun === null) return null;
  const requester = await requesterForChat(args.pool, args.chatId);
  if (requester === null) return null;
  const children = await args.store.childCount(parentRun.id);
  return {
    pool: args.pool,
    store: args.store,
    threads: args.threads,
    agent: args.agent,
    parentRun,
    requester,
    runtime: args.runtime,
    timeoutMs: args.timeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS,
    can_spawn: parentRun.depth < MAX_DELEGATION_DEPTH && children < MAX_CHILDREN_PER_RUN,
  };
}

const textErr = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

const delegateOutput = Type.Object({
  run_id: Type.String(),
  text: Type.String(),
  attachments: Type.Array(Type.String()),
});

function errorResult(error: unknown): ToolExecutionResult {
  const code = error instanceof DelegationError ? error.code : "delegation_failed";
  const message = error instanceof Error ? error.message : String(error);
  return textErr(JSON.stringify({ error: code, message }));
}

export function createDelegateTool(context: DelegationToolContext): ToolRegistration {
  return defineTool({
    name: "delegate",
    description:
      "Delegate a task to another agent in this organization. The target runs in its own workspace with its own " +
      "model and tool allowlist and returns text plus the ids of the files it sent. The child gets the task text and " +
      "optional context, never this conversation's transcript. Limits: depth 2, 3 children per run.",
    parameters: Type.Object({
      agent: Type.String({ description: "Target agent id or exact name within this organization" }),
      task: Type.String({ description: "The task for the target agent" }),
      context: Type.Optional(
        Type.String({ description: "Optional context or artifact references; never the live transcript" }),
      ),
    }),
    structuredOutputSchema: delegateOutput,
    replay: "unsafe",
    callers: ["tools"],
    outputLimits: { maxBytes: 32 * 1024 },
    execute: async (args) => {
      try {
        const result = await delegate(context, {
          agent: args.agent,
          task: args.task,
          ...(args.context === undefined ? {} : { context: args.context }),
        });
        return { structuredOutput: result as unknown as JsonValue };
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}
