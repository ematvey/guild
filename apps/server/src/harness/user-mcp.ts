// The user-MCP chat runtime: per turn the chat owner's enabled MCP servers
// resolve into a snapshot, one dynamic per-conversation registry extension carries
// the prompt index, and every discovered tool is available to codemode as
// mcp<length>_<server>_<tool> (no disclosure pair — the scale is small and
// the user owns the servers). Nothing is cached across turns: discovery is
// per-turn; secrets never ride the snapshot (headers re-decrypt at call
// time); one unreachable server degrades to a diagnostic line, never a
// failed turn.

import type { Context } from "@earendil-works/chord";
import type {
  Extension,
  PromptSection,
  Registry,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import { toolSchema } from "./tool-schema.js";
import { userMcpToolName } from "../platform/domain/mcp.js";
export { userMcpToolName } from "../platform/domain/mcp.js";
import type { Logger } from "pino";
import { mcpConnect } from "../integrations/mcp.js";
import { validateUrl } from "../integrations/mcp-url.js";
import type { JsonObject } from "../integrations/shared.js";
import type { UserMcpStore } from "../platform/store/user-mcp.js";
import type { TurnPreparation } from "./integrations.js";

interface ResolvedTool {
  serverId: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: unknown;
}

interface TurnSnapshot {
  orgId: string;
  chatId: string;
  userId: string;
  /** The turn's enabled rows (headers still encrypted). */
  servers: { id: string; name: string; url: string; headersEnc: Buffer | null }[];
  tools: ResolvedTool[];
  /** The prompt-index lines (reachable servers + unreachable diagnostics). */
  lines: string[];
}

export interface UserMcpRuntimeDeps {
  store: UserMcpStore;
  masterKey(): Buffer;
  log: Logger;
  chatOfConversation(conversationId: number): Promise<string | null>;
  chatOwnerOf(chatId: string): Promise<{ org_id: string; user_id: string } | null>;
}

export class UserMcpRuntime {
  private readonly snapshots = new Map<number, TurnSnapshot>();

  constructor(
    private readonly deps: UserMcpRuntimeDeps,
    private readonly registry: Registry<ToolRegistration>,
  ) {}

  extensionName(userId: string, conversationId?: number): string {
    return `guild-user-mcp:${userId}${conversationId === undefined ? "" : `:${conversationId}`}`;
  }

  forget(conversationId: number): void {
    const snapshot = this.snapshots.get(conversationId);
    if (snapshot) {
      const extension = this.registry.snapshot().extension(this.extensionName(snapshot.userId, conversationId));
      if (extension) this.registry.uninstall(extension);
    }
    this.snapshots.delete(conversationId);
  }

  private warn(message: string): void {
    this.deps.log.warn(message);
  }

  /** Turn start: resolve the chat owner's enabled servers, discover their
   *  tools live, cache the snapshot for the turn's calls, install the
   *  per-conversation extension, and return the tool registrations the model may
   *  call. A server that fails to connect or list contributes zero tools
   *  and one diagnostic line — the turn never fails over one bad server. */
  async prepareTurn(
    conversationId: number,
    chatId: string,
    orgId: string,
    signal?: AbortSignal,
  ): Promise<TurnPreparation> {
    const snapshot = await this.resolveSnapshot(chatId, orgId, signal);
    this.snapshots.set(conversationId, snapshot);
    if (snapshot.servers.length === 0) {
      return { extensions: [], tools: [] };
    }
    const extension = this.installUserExtension(snapshot, conversationId);
    const tools = extension.tools ?? [];
    return { extensions: [extension], tools };
  }

  /** Resolves the turn snapshot: the chat owner's enabled servers, live
   *  tool discovery, and the prompt-index lines. Unreachable servers keep
   *  their row (call time re-checks) but contribute no tools. */
  private async resolveSnapshot(chatId: string, orgId: string, signal?: AbortSignal): Promise<TurnSnapshot> {
    const base: TurnSnapshot = { orgId, chatId, userId: "", servers: [], tools: [], lines: [] };
    let owner: { org_id: string; user_id: string } | null;
    try {
      owner = await this.deps.chatOwnerOf(chatId);
    } catch (error) {
      this.warn(`user-mcp chat owner resolution failed: ${(error as Error).message}`);
      throw error;
    }
    if (owner === null) return base;
    base.userId = owner.user_id;
    let rows: Awaited<ReturnType<UserMcpStore["listEnabled"]>> = [];
    try {
      rows = await this.deps.store.listEnabled(orgId, owner.user_id);
    } catch (error) {
      this.warn(`user-mcp server resolution failed: ${(error as Error).message}`);
      throw error;
    }
    const masterKey = this.deps.masterKey();
    const deadline = AbortSignal.any([AbortSignal.timeout(20_000), ...(signal ? [signal] : [])]);
    let next = 0;
    const resolved = await Promise.all(
      Array.from({ length: Math.min(4, rows.length) }, async () => {
        const results: {
          index: number;
          server: TurnSnapshot["servers"][number];
          tools: ResolvedTool[];
          line: string;
        }[] = [];
        for (;;) {
          const index = next++;
          const row = rows[index];
          if (!row) break;
          const tools: ResolvedTool[] = [];
          let line = "";
          const server = { id: row.id, name: row.name, url: row.url, headersEnc: row.headers_enc };

          try {
            await validateUrl(row.url);
            const peer = await mcpConnect(
              row.url,
              this.deps.store.resolveHeaders(row.headers_enc, masterKey),
              deadline,
            );
            const listed = await peer.listTools();
            for (const tool of listed) {
              toolSchema(tool.inputSchema);
              tools.push({
                serverId: row.id,
                serverName: row.name,
                toolName: tool.name,
                description: tool.description,
                inputSchema: tool.inputSchema,
              });
            }
            line = `MCP ${row.name}: ${listed.length} tools — call ${userMcpToolName(row.name, "<tool>")} through codemode; its schema is available to scripts.`;
          } catch (error) {
            tools.length = 0;
            line = `MCP ${row.name}: unreachable (${(error as Error).message})`;
          }
          results.push({ index, server, tools, line });
        }
        return results;
      }),
    );
    for (const result of resolved.flat().sort((a, b) => a.index - b.index)) {
      base.servers.push(result.server);
      base.tools.push(...result.tools);
      base.lines.push(result.line);
    }
    signal?.throwIfAborted();
    const names = base.tools.map((tool) => userMcpToolName(tool.serverName, tool.toolName));
    if (new Set(names).size !== names.length) throw new Error("duplicate MCP tool name");
    return base;
  }

  /** Installs (or replaces in place) the per-conversation extension: the prompt
   *  index section plus every declared tool (pi-durable resolves a
   *  conversation's tool allow-list against the installed extensions — the
   *  integrations runtime carries its connector tools the same way). */
  private installUserExtension(snapshot: TurnSnapshot, conversationId: number): Extension<ToolRegistration> {
    const tools = snapshot.tools.map((t) => this.toolRegistration(t));
    const runtime = this;
    const section: PromptSection<ToolRegistration> = {
      key: "user-mcp",
      tag: false,
      async render(input) {
        const snap = await runtime.snapshotFor(Number(input.conversationId));
        if (snap === undefined || snap.servers.length === 0) return undefined;
        return `User MCP servers (their tools are available to codemode):\n${snap.lines.map((line) => `- ${line}`).join("\n")}`;
      },
    };
    const extension: Extension<ToolRegistration> = {
      name: this.extensionName(snapshot.userId, conversationId),
      tools,
      sections: [section],
    };
    this.registry.install(extension);
    return extension;
  }

  /** The turn snapshot: the turn-start cache, or a live re-resolve (restart
   *  recovery — a turn re-running its calls after a process restart
   *  re-derives them). Users without servers resolve to an empty snapshot. */
  private async snapshotFor(conversationId: number): Promise<TurnSnapshot | undefined> {
    const cached = this.snapshots.get(conversationId);
    if (cached !== undefined) return cached;
    const chatId = await this.deps.chatOfConversation(conversationId);
    if (chatId === null) return undefined;
    let orgId: string | null = null;
    try {
      const res = await this.deps.chatOwnerOf(chatId);
      orgId = res?.org_id ?? null;
    } catch {
      orgId = null;
    }
    if (orgId === null) return undefined;
    const snapshot = await this.resolveSnapshot(chatId, orgId);
    this.snapshots.set(conversationId, snapshot);
    if (snapshot.servers.length > 0) this.installUserExtension(snapshot, conversationId);
    return snapshot;
  }

  /** One MCP tool as a declared registration: the JSON-schema input passes
   *  through; the call re-decrypts the stored headers at call time. */
  private toolRegistration(tool: ResolvedTool): ToolRegistration {
    const wireName = userMcpToolName(tool.serverName, tool.toolName);
    const runtime = this;
    const registration = {
      name: wireName,
      description: tool.description,
      parameters: toolSchema(tool.inputSchema),
      callers: ["tools"] as const,
      replay: "unsafe" as const,
      async execute(args: unknown, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
        context.abortSignal?.throwIfAborted();
        const outcome = await runtime.executeToolCall(
          Number(api.conversationId),
          wireName,
          tool,
          (args ?? {}) as JsonObject,
          context.abortSignal,
        );
        context.abortSignal?.throwIfAborted();
        return {
          isError: outcome.isError,
          output: [{ type: "text", text: outcome.content }],
        };
      },
    } satisfies ToolRegistration;
    return registration;
  }

  /** The approval-gate classification of one call: a declared user-MCP
   *  tool flows without a card (the user owns the server and enabled it —
   *  there is no org curation layer to force one); anything else is not a
   *  user-MCP tool (the generic policy applies). */
  async gateDecision(conversationId: number, callName: string): Promise<"skip" | undefined> {
    const snapshot = await this.snapshotFor(conversationId);
    if (snapshot === undefined) return undefined;
    if (!snapshot.tools.some((t) => userMcpToolName(t.serverName, t.toolName) === callName)) return undefined;
    return "skip";
  }

  /** Executes one user-MCP tool call: the server row is re-read fresh (a
   *  server deleted or disabled mid-turn stops answering), the headers
   *  re-decrypt at call time, and the result maps per the MCP contract
   *  (text blocks joined with \n; isError surfaces as an error result,
   *  never a thrown transport error). */
  private async executeToolCall(
    conversationId: number,
    wireName: string,
    declared: ResolvedTool,
    args: JsonObject,
    signal?: AbortSignal,
  ): Promise<{ content: string; isError: boolean }> {
    const snapshot = await this.snapshotFor(conversationId);
    const server = snapshot?.servers.find((s) => s.id === declared.serverId);
    if (snapshot === undefined || server === undefined) {
      return { content: `unknown server tool ${wireName}`, isError: true };
    }
    const owner = await this.deps.chatOwnerOf(snapshot.chatId).catch(() => null);
    if (owner === null) {
      return { content: `unknown server tool ${wireName}`, isError: true };
    }
    const row = await this.deps.store.get(owner.org_id, owner.user_id, server.id).catch(() => null);
    if (row === null || !row.enabled) {
      return { content: `MCP server ${server.name} is no longer enabled`, isError: true };
    }
    try {
      await validateUrl(row.url);
      const peer = await mcpConnect(
        row.url,
        this.deps.store.resolveHeaders(row.headers_enc, this.deps.masterKey()),
        signal,
      );
      const result = await peer.callTool(declared.toolName, args);
      return { content: result.content, isError: result.isError };
    } catch (error) {
      return { content: `mcp tool call failed: ${(error as Error).message}`, isError: true };
    }
  }
}
