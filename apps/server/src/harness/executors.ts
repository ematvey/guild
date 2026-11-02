// Where a conversation's tools execute: the chat's bound machine (machine
// dispatch), an agent's workspace sandbox, or the conversation's own
// sandbox (plain chats). Builds the execution env the harness and the skill
// runtime ask for, and puts the turn's attachments and the owner's skills
// into a sandbox before the turn's tools run.

import { mkdir } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ExecutionEnv } from "@earendil-works/pi-durable/env";
import type { Logger } from "pino";
import type { Config } from "../config.js";
import type { PlatformPool } from "../platform/db.js";
import type { ObjectStore } from "../platform/s3.js";
import type { AttachmentStore } from "../platform/store/attachments.js";
import type { ChatStore } from "../platform/store/chats.js";
import type { ThreadStore } from "../platform/store/thread.js";
import { RunnerClient, SandboxPool, type SandboxTarget } from "../sandbox/client.js";
import { MachineExecutionEnv, type ExecutorKind, type MachineDispatch } from "../machines/dispatch.js";
import { agentThreadForChat, agentWorkspaceSubpath, resolveConversationWorkspace } from "../agents/workspace.js";
import type { AgentStore } from "../agents/store.js";
import { materializeTurnAttachments } from "../chats/attachment-materialize.js";
import type { SkillRuntime } from "./skills.js";

export interface ExecutorDeps {
  readonly config: Pick<Config, "sandbox" | "sandboxRoot" | "agentWorkspaceRoot" | "clientToolTimeoutMs">;
  /** The agent-thread reads (workspace resolution). */
  readonly pool: PlatformPool;
  readonly log: Logger;
  readonly chats: Pick<ChatStore, "identityOf" | "machineBinding" | "ownerOf">;
  readonly threads: Pick<ThreadStore, "turnAttachmentIds">;
  readonly attachments: Pick<AttachmentStore, "byIds">;
  readonly agents: Pick<AgentStore, "runningRunForChat">;
  readonly objects?: ObjectStore;
  /** The conversation's chat id (null for unmapped conversations). */
  chatOfConversation(conversationId: number): Promise<string | null>;
  /** The machine dispatch registry machine-bound chats run through. */
  machineDispatch(): Pick<MachineDispatch, "dispatch"> | undefined;
  /** The skill runtime (materialization into plain chats' sandboxes). */
  skills(): Pick<SkillRuntime, "materializeIntoSandbox" | "materializeSkill">;
}

export class ConversationExecutors {
  /** Server-side tool sandboxes (GUILD_SANDBOX=runner); null otherwise. */
  private readonly sandboxes: SandboxPool | null;
  /** Sandbox key → chat id, for the connect-time skill materialization. */
  private readonly sandboxChats = new Map<string, string>();
  /** Chat → run whose turn directory is already materialized. */
  private readonly materializedTurns = new Map<string, string>();

  constructor(private readonly deps: ExecutorDeps) {
    const { sandbox } = deps.config;
    this.sandboxes =
      sandbox.mode === "runner"
        ? new SandboxPool({
            runner: new RunnerClient(sandbox.runnerUrl, sandbox.runnerToken),
            log: deps.log,
            onConnected: async (target, env) => {
              const chatId = this.sandboxChats.get(target.key);
              if (chatId !== undefined) await this.materializeSandboxSkills(chatId, env);
            },
          })
        : null;
  }

  /** Where this conversation's tools execute — the env factory and the
   *  approval gate both resolve through this: the chat's bound machine, an
   *  agent thread's workspace sandbox, or the per-conversation sandbox
   *  (null: a plain chat, or an unmapped conversation). */
  async executorKind(conversationId: number): Promise<ExecutorKind> {
    const chatId = await this.deps.chatOfConversation(conversationId);
    if (chatId === null) return null;
    const chat = await this.deps.chats.identityOf(chatId);
    if (chat === null) return null;
    if (chat.machine_id !== null) return "machine";
    return (await this.agentWorkspaceForChat(chat.org_id, chatId)) !== null ? "server" : null;
  }

  /** The harness env factory: the machine env for a machine-bound chat,
   *  else the server-side sandbox with the owner's skills and the turn's
   *  attachments in place. */
  async harnessEnv(conversationId: number): Promise<ExecutionEnv> {
    const kind = await this.executorKind(conversationId);
    const chatId = await this.deps.chatOfConversation(conversationId);
    if (kind === "machine") {
      const dispatch = this.deps.machineDispatch();
      if (dispatch === undefined) throw new Error("machine-bound chat has no dispatch host");
      const binding = chatId === null ? null : await this.deps.chats.machineBinding(chatId);
      if (chatId === null || binding === null) throw new Error("machine-bound chat lost its machine");
      return new MachineExecutionEnv({
        machineId: binding.machine_id,
        orgId: binding.org_id,
        chatId,
        workdir: binding.project_folder,
        timeoutMs: this.deps.config.clientToolTimeoutMs,
        dispatch,
      });
    }
    if (chatId === null) {
      // Unmapped conversations have no org to sandbox under; only the
      // in-process executor serves them.
      if (this.deps.config.sandbox.mode !== "inprocess-unsafe") throw new Error("no chat is bound to this conversation");
      const dir = `${this.deps.config.sandboxRoot}/${conversationId}`;
      await mkdir(dir, { recursive: true });
      return new NodeExecutionEnv({ cwd: dir });
    }
    const chat = await this.deps.chats.identityOf(chatId);
    if (chat === null) throw new Error(`chat ${chatId} not found`);
    const env = await this.envFor(conversationId, chat.org_id, { materialize: true });
    await this.materializeAttachmentsForTurn(chatId, chat.org_id, env);
    return env;
  }

  /** The execution env for a conversation's server-side tools: a runner
   *  sandbox, or the in-process executor (tests/dev). */
  async envFor(conversationId: number, orgId: string, opts: { materialize?: boolean } = {}): Promise<ExecutionEnv> {
    const target = await this.sandboxTarget(conversationId, orgId);
    switch (this.deps.config.sandbox.mode) {
      case "runner": {
        if (target.chatId !== null) this.sandboxChats.set(target.key, target.chatId);
        return this.sandboxes!.envFor({ key: target.key, subpath: target.subpath });
      }
      case "inprocess-unsafe": {
        // NodeExecutionEnv.exec requires an existing cwd; the dir is
        // created lazily on first tool use.
        await mkdir(target.hostDir, { recursive: true });
        const env = new NodeExecutionEnv({ cwd: target.hostDir });
        if (opts.materialize && target.chatId !== null) await this.materializeSandboxSkills(target.chatId, env);
        return env;
      }
    }
  }

  /** Removes a conversation's sandbox container (its files stay on the
   *  volume); a no-op outside runner mode. */
  async removeSandbox(target: SandboxTarget): Promise<void> {
    await this.sandboxes?.remove(target);
  }

  /** The read_skill install-on-use dep: one freshly installed skill into a
   *  plain chat's dir; the caller in harness/skills.ts catches and logs, so
   *  errors must not escape here. An agent workspace gets nothing. */
  async materializeInstalledSkill(args: {
    conversationId: number;
    orgId: string;
    slug: string;
    version: string;
  }): Promise<void> {
    const chatId = await this.deps.chatOfConversation(args.conversationId);
    if (chatId === null) return;
    if ((await this.agentWorkspaceForChat(args.orgId, chatId)) !== null) return;
    const env = await this.envFor(args.conversationId, args.orgId);
    await this.deps.skills().materializeSkill(args.orgId, args.slug, args.version, env);
  }

  /** Drops the per-run caches of one chat once its run ends. */
  forgetRun(chatId: string): void {
    this.materializedTurns.delete(chatId);
    for (const [key, owner] of this.sandboxChats) if (owner === chatId) this.sandboxChats.delete(key);
  }

  async close(): Promise<void> {
    await this.sandboxes?.close().catch((error: unknown) => this.deps.log.warn({ err: error }, "sandbox pool close failed"));
  }

  /** The sandbox target of a conversation: the agent workspace for an agent
   *  thread, else the conversation's own dir (`chats/<org>/<id>`). */
  private async sandboxTarget(
    conversationId: number,
    orgId: string,
  ): Promise<SandboxTarget & { hostDir: string; chatId: string | null }> {
    const chatId = await this.deps.chatOfConversation(conversationId);
    const target = await resolveConversationWorkspace(this.deps.pool, {
      conversationId,
      orgId,
      chatId,
      agentWorkspaceRoot: this.deps.config.agentWorkspaceRoot,
      plainHostRoot: this.deps.config.sandboxRoot,
    });
    return { key: target.key, subpath: target.subpath, hostDir: target.hostDir, chatId: target.chatId };
  }

  /** The agent workspace subpath behind a chat, or null for a plain chat. */
  private async agentWorkspaceForChat(orgId: string, chatId: string | null): Promise<string | null> {
    if (chatId === null) return null;
    const agent = await agentThreadForChat(this.deps.pool, chatId);
    return agent === null ? null : agentWorkspaceSubpath(orgId, agent.agent_id);
  }

  /** Turn-start skill materialization: the chat owner's installed org
   *  skills land under the sandbox root before the turn's tools run, so a
   *  plain chat's agent can read a skill's extra files with read_file.
   *  An agent workspace outlives the conversation and belongs to the agent,
   *  so no skill files are copied into it — read_skill serves the registry
   *  bundle instead. Never throws: a broken bundle or a store failure is
   *  logged and the turn proceeds without the skill files. */
  private async materializeSandboxSkills(chatId: string, env: ExecutionEnv): Promise<void> {
    try {
      const owner = await this.deps.chats.ownerOf(chatId);
      if (owner === null) return;
      if ((await this.agentWorkspaceForChat(owner.org_id, chatId)) !== null) return;
      await this.deps.skills().materializeIntoSandbox(owner.org_id, owner.user_id, env);
    } catch (error) {
      this.deps.log.warn({ err: error, chatId }, "skill materialization failed");
    }
  }

  /** Writes the turn's attachments into the sandbox at
   *  /tmp/attachments/<runId>/ and wipes the previous turn's directory.
   *  Runs once per run, before the first tool call. */
  private async materializeAttachmentsForTurn(chatId: string, orgId: string, env: ExecutionEnv): Promise<void> {
    const objects = this.deps.objects;
    if (objects === undefined || this.deps.config.sandbox.mode !== "runner") return;
    const run = await this.deps.agents.runningRunForChat(chatId).catch(() => null);
    if (run === null) return;
    if (this.materializedTurns.get(chatId) === run.id) return;
    this.materializedTurns.set(chatId, run.id);
    try {
      const ids = await this.deps.threads.turnAttachmentIds(chatId, run.id, run.started_at ?? run.created_at);
      const rows = await this.deps.attachments.byIds(orgId, ids);
      await materializeTurnAttachments({ env, objects, orgId, runId: run.id, rows, context: BACKGROUND_CONTEXT });
    } catch (error) {
      this.materializedTurns.delete(chatId);
      this.deps.log.warn({ err: error, chatId, runId: run.id }, "attachment materialization failed");
    }
  }
}
