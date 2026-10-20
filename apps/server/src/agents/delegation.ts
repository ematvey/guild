// Agent-to-agent delegation: a child run in the target agent's workspace,
// bounded by depth/child/cycle rules, returning text plus declared artifact
// files copied into the parent's inbox (or the shared staging area when
// large). Artifacts are never cleaned up automatically.

import { constants } from "node:fs";
import { copyFile, lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
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
import { normalizeRelativePath } from "./files.js";
import type { AgentStore } from "./store.js";
import type {
  Agent,
  AgentDelegationArtifact,
  AgentRun,
  AgentRunStatus,
} from "./types.js";

export const MAX_DELEGATION_DEPTH = 2;
export const MAX_CHILDREN_PER_RUN = 3;
export const MAX_ARTIFACTS = 20;
export const MAX_INBOX_ARTIFACT_BYTES = 16 * 1024 * 1024;
export const DEFAULT_DELEGATION_TIMEOUT_MS = 120_000;
const POLL_MS = 250;
const TERMINAL: ReadonlySet<AgentRunStatus> = new Set(["succeeded", "failed", "silent", "skipped"]);

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
  workspaceRoot: string;
  stagingRoot: string;
  timeoutMs: number;
  /** False when depth or child count has removed the delegate tool. */
  can_spawn: boolean;
}

export interface DelegateArgs {
  agent: string;
  task: string;
  context?: string;
}

export interface DelegatedArtifact {
  path: string;
  size: number;
  status: "inbox" | "staged";
  inbox_path: string | null;
  staging_path: string | null;
}

export interface DelegateResult {
  run_id: string;
  text: string;
  artifacts: DelegatedArtifact[];
}

export class DelegationError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

function rootFor(workspaceRoot: string, orgId: string, agentId: string): string {
  return path.resolve(workspaceRoot, "agents", orgId, agentId);
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
    `SELECT a.id, a.org_id, a.owner_user_id, a.name, a.instructions, a.model,
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
    instructions: (row.instructions as string | null) ?? "",
    model: row.model as string,
    tools: (row.tools as Agent["tools"] | null) ?? [],
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
  parts.push("Work only in your own workspace. Return a concise result; files you write are returned to the parent.");
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

async function declaredPaths(pool: PlatformPool, runId: string): Promise<string[]> {
  const res = await pool.query<{ paths: string[] }>(
    "SELECT paths FROM agent_workspace_turns WHERE run_id = $1 ORDER BY started_at ASC",
    [runId],
  );
  return [...new Set(res.rows.flatMap((row) => row.paths))];
}

async function copyOne(source: string, destination: string): Promise<void> {
  await mkdir(path.dirname(destination), { recursive: true });
  try {
    await copyFile(source, destination, constants.COPYFILE_FICLONE);
  } catch {
    await copyFile(source, destination);
  }
}

/** Clones declared child files into the parent's inbox/<run-id>/, or into
 *  /tmp/delegations/<run-id>/ when a file exceeds the inbox threshold. */
export async function transferArtifacts(args: {
  store: AgentStore;
  parentAgentId: string;
  parentRunId: string;
  childRunId: string;
  childAgentId: string;
  childRoot: string;
  parentRoot: string;
  stagingRoot: string;
  declared: string[];
  maxFiles?: number;
  maxInboxBytes?: number;
}): Promise<DelegatedArtifact[]> {
  const maxFiles = Math.max(1, Math.min(MAX_ARTIFACTS, args.maxFiles ?? MAX_ARTIFACTS));
  const maxBytes = args.maxInboxBytes ?? MAX_INBOX_ARTIFACT_BYTES;
  const realChild = await realpath(args.childRoot).catch(() => null);
  if (realChild === null) return [];
  const out: DelegatedArtifact[] = [];
  for (const candidate of args.declared) {
    if (out.length >= maxFiles) break;
    let rel: string;
    try {
      rel = normalizeRelativePath(candidate);
    } catch {
      continue;
    }
    if (rel === "") continue;
    const source = path.resolve(realChild, rel);
    if (source !== realChild && !source.startsWith(realChild + path.sep)) continue;
    const stats = await lstat(source).catch(() => null);
    if (stats === null || !stats.isFile() || stats.isSymbolicLink()) continue;
    const large = Number(stats.size) > maxBytes;
    const inboxRel = path.posix.join("inbox", args.childRunId, rel);
    const destination = large
      ? path.resolve(args.stagingRoot, args.childRunId, rel)
      : path.resolve(args.parentRoot, inboxRel);
    const parentRel = large ? null : inboxRel;
    await copyOne(source, destination);
    const artifact = await args.store.createArtifact({
      run_id: args.childRunId,
      parent_run_id: args.parentRunId,
      agent_id: args.childAgentId,
      path: rel,
      size: Number(stats.size),
      status: large ? "staged" : "inbox",
      inbox_path: parentRel,
      staging_path: large ? destination : null,
    });
    out.push({
      path: artifact.path,
      size: artifact.size,
      status: large ? "staged" : "inbox",
      inbox_path: artifact.inbox_path,
      staging_path: artifact.staging_path,
    });
  }
  return out;
}

/** Deletes the staging directory for one child run and marks its staged
 *  artifacts released. No other cleanup runs automatically. */
export async function releaseArtifacts(
  store: AgentStore,
  stagingRoot: string,
  runId: string,
): Promise<{ run_id: string; staging_dir: string; released: DelegatedArtifact[] }> {
  const stagingDir = path.resolve(stagingRoot, runId);
  const rows = await store.releaseArtifacts(runId);
  await rm(stagingDir, { recursive: true, force: true });
  return {
    run_id: runId,
    staging_dir: stagingDir,
    released: rows.map((row) => ({
      path: row.path,
      size: row.size,
      status: "staged",
      inbox_path: row.inbox_path,
      staging_path: row.staging_path,
    })),
  };
}

/** Creates the child run and thread, submits the isolated task, waits for a
 *  terminal state, then transfers declared artifacts. */
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
  const thread = await context.store.createThread(target.id, title, "routine_run");
  const childRun = await context.store.createRun({
    agent_id: target.id,
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
        error_message: message,
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
  const childRoot = rootFor(context.workspaceRoot, target.org_id, target.id);
  const parentRoot = rootFor(context.workspaceRoot, context.agent.org_id, context.agent.id);
  const artifacts = await transferArtifacts({
    store: context.store,
    parentAgentId: context.agent.id,
    parentRunId: context.parentRun.id,
    childRunId: childRun.id,
    childAgentId: target.id,
    childRoot,
    parentRoot,
    stagingRoot: context.stagingRoot,
    declared: await declaredPaths(context.pool, childRun.id),
  });
  return { run_id: childRun.id, text, artifacts };
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
  workspaceRoot: string;
  stagingRoot?: string;
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
    workspaceRoot: args.workspaceRoot,
    stagingRoot: args.stagingRoot ?? path.join("/tmp", "delegations"),
    timeoutMs: args.timeoutMs ?? DEFAULT_DELEGATION_TIMEOUT_MS,
    can_spawn: parentRun.depth < MAX_DELEGATION_DEPTH && children < MAX_CHILDREN_PER_RUN,
  };
}

/** Fallback declaration for tests and simple child agents: every regular
 *  file under outbox/, relative to the child root. */
export async function outboxFiles(childRoot: string): Promise<string[]> {
  const root = path.join(childRoot, "outbox");
  const out: string[] = [];
  const walk = async (dir: string, rel: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const childRel = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) await walk(path.join(dir, entry.name), childRel);
      else if (entry.isFile()) out.push(`outbox/${childRel}`);
    }
  };
  await walk(root, "");
  return out;
}

const textErr = (text: string): ToolExecutionResult => ({ output: [{ type: "text", text }], isError: true });

const delegateOutput = Type.Object({
  run_id: Type.String(),
  text: Type.String(),
  artifacts: Type.Array(
    Type.Object({
      path: Type.String(),
      size: Type.Number(),
      status: Type.Union([Type.Literal("inbox"), Type.Literal("staged")]),
      inbox_path: Type.Union([Type.String(), Type.Null()]),
      staging_path: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
});

const releaseOutput = Type.Object({
  run_id: Type.String(),
  staging_dir: Type.String(),
  released: Type.Array(
    Type.Object({
      path: Type.String(),
      size: Type.Number(),
      status: Type.Literal("staged"),
      inbox_path: Type.Union([Type.String(), Type.Null()]),
      staging_path: Type.Union([Type.String(), Type.Null()]),
    }),
  ),
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
      "model and tool allowlist and returns text plus declared artifact files. The child gets the task text and " +
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

export function createReleaseArtifactsTool(context: DelegationToolContext): ToolRegistration {
  return defineTool({
    name: "release_artifacts",
    description:
      "Delete the staging directory of a delegated child run and report the files it released. Files above 16 MiB " +
      "stay in /tmp/delegations/<run-id>/ until this call. Nothing is cleaned up automatically.",
    parameters: Type.Object({
      run_id: Type.String({ description: "The delegated child run id whose staging area to release" }),
    }),
    structuredOutputSchema: releaseOutput,
    replay: "unsafe",
    callers: ["tools"],
    outputLimits: { maxBytes: 16 * 1024 },
    execute: async (args) => {
      try {
        const run = await context.store.getRun(args.run_id);
        if (run.parent_run_id !== context.parentRun.id) {
          throw new DelegationError("forbidden", "run is not a child of this run");
        }
        const result = await releaseArtifacts(context.store, context.stagingRoot, args.run_id);
        return { structuredOutput: result as unknown as JsonValue };
      } catch (error) {
        return errorResult(error);
      }
    },
  });
}

export type { AgentDelegationArtifact };
