// The user-MCP chat runtime: per turn the chat owner's enabled MCP servers
// resolve into a snapshot, one dynamic per-user registry extension carries
// the prompt index, and every discovered tool is declared directly to the
// model as mcp_<server>_<tool> (no disclosure pair — the scale is small and
// the user owns the servers). Nothing is cached across turns: discovery is
// per-turn; secrets never ride the snapshot (headers re-decrypt at call
// time); one unreachable server degrades to a diagnostic line, never a
// failed turn.

import type {
  Extension,
  PromptSection,
  Registry,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { TSchema } from "@earendil-works/pi-ai";
import type { Logger } from "pino";
import { mcpConnect } from "../platform/integrations/mcp.js";
import type { UserMcpStore } from "../platform/store/userMcp.js";
import type { TurnPreparation } from "./integrations.js";

type Json = Record<string, unknown>;

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
  at: number;
}

export interface UserMcpRuntimeDeps {
  store: UserMcpStore;
  masterKey(): Buffer;
  log: Logger;
  chatOfConversation(conversationId: number): Promise<string | null>;
  chatOwnerOf(chatId: string): Promise<{ org_id: string; user_id: string } | null>;
}

/** The wire tool name for one user-MCP tool. */
export function userMcpToolName(serverName: string, toolName: string): string {
  return `mcp_${serverName}_${toolName}`;
}

export class UserMcpRuntime {
  private readonly snapshots = new Map<number, TurnSnapshot>();
  private readonly configured = new Map<number, string>();

  constructor(
    private readonly deps: UserMcpRuntimeDeps,
    private readonly registry: Registry<ToolRegistration>,
  ) {}

  extensionName(userId: string): string {
    return `guild-user-mcp:${userId}`;
  }

  private warn(message: string): void {
    this.deps.log.warn(message);
  }

  /** Turn start: resolve the chat owner's enabled servers, discover their
   *  tools live, cache the snapshot for the turn's calls, install the
   *  per-user extension, and return the tool registrations the model may
   *  call. A server that fails to connect or list contributes zero tools
   *  and one diagnostic line — the turn never fails over one bad server. */
  async prepareTurn(conversationId: number, chatId: string, orgId: string): Promise<TurnPreparation> {
    const snapshot = await this.resolveSnapshot(chatId, orgId);
    this.snapshots.set(conversationId, snapshot);
    if (snapshot.servers.length === 0) {
      if (this.configured.has(conversationId)) {
        this.configured.delete(conversationId);
        return { action: "clear", extensions: [], tools: [] };
      }
      return { action: "none", extensions: [], tools: [] };
    }
    const extension = this.installUserExtension(snapshot);
    const tools = snapshot.tools.map((t) => this.toolRegistration(t));
    return { action: "configure", extensions: [extension], tools };
  }

  /** Resolves the turn snapshot: the chat owner's enabled servers, live
   *  tool discovery, and the prompt-index lines. Unreachable servers keep
   *  their row (call time re-checks) but contribute no tools. */
  private async resolveSnapshot(chatId: string, orgId: string): Promise<TurnSnapshot> {
    const base: TurnSnapshot = { orgId, chatId, userId: "", servers: [], tools: [], lines: [], at: Date.now() };
    let owner: { org_id: string; user_id: string } | null;
    try {
      owner = await this.deps.chatOwnerOf(chatId);
    } catch (error) {
      this.warn(`user-mcp chat owner resolution failed: ${(error as Error).message}`);
      return base;
    }
    if (owner === null) return base;
    base.userId = owner.user_id;
    let rows: Awaited<ReturnType<UserMcpStore["listEnabled"]>> = [];
    try {
      rows = await this.deps.store.listEnabled(orgId, owner.user_id);
    } catch (error) {
      this.warn(`user-mcp server resolution failed, the turn continues without them: ${(error as Error).message}`);
      return base;
    }
    const masterKey = this.deps.masterKey();
    for (const row of rows) {
      const server = { id: row.id, name: row.name, url: row.url, headersEnc: row.headers_enc };
      base.servers.push(server);
      try {
        const peer = await mcpConnect(row.url, this.deps.store.resolveHeaders(row.headers_enc, masterKey));
        const listed = await peer.listTools();
        for (const tool of listed) {
          base.tools.push({
            serverId: row.id,
            serverName: row.name,
            toolName: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
          });
        }
        base.lines.push(
          `MCP ${row.name}: ${listed.length} tools — call ${userMcpToolName(row.name, "<tool>")} directly; the schema is declared.`,
        );
      } catch (error) {
        base.lines.push(`MCP ${row.name}: unreachable (${(error as Error).message})`);
      }
    }
    return base;
  }

  /** Installs (or replaces in place) the per-user extension: the prompt
   *  index section; the tools ride the conversation's bare registrations
   *  (prepareTurn's `tools`), the same way the integrations runtime passes
   *  connector tools. */
  private installUserExtension(snapshot: TurnSnapshot): Extension<ToolRegistration> {
    const runtime = this;
    const section: PromptSection<ToolRegistration> = {
      key: "user-mcp",
      tag: false,
      async render(input) {
        const snap = await runtime.snapshotFor(Number(input.conversationId));
        if (snap === undefined || snap.servers.length === 0) return undefined;
        return `User MCP servers (their tools are declared):\n${snap.lines.map((line) => `- ${line}`).join("\n")}`;
      },
    };
    const extension: Extension<ToolRegistration> = {
      name: this.extensionName(snapshot.userId),
      tools: [],
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
    if (cached !== undefined && Date.now() - cached.at < 10 * 60_000) return cached;
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
    if (snapshot.servers.length > 0) this.installUserExtension(snapshot);
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
      parameters: tool.inputSchema as TSchema,
      replay: "unsafe" as const,
      async execute(args: unknown, api: ToolExecutionApi): Promise<ToolExecutionResult> {
        const outcome = await runtime.executeToolCall(Number(api.conversationId), wireName, tool, (args ?? {}) as Json);
        return {
          isError: outcome.isError,
          content: [{ type: "text", text: outcome.content }],
        };
      },
    } as unknown as ToolRegistration;
    return registration;
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
    args: Json,
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
      const peer = await mcpConnect(row.url, this.deps.store.resolveHeaders(row.headers_enc, this.deps.masterKey()));
      const result = await peer.callTool(declared.toolName, args);
      return { content: result.content, isError: result.isError };
    } catch (error) {
      return { content: `mcp tool call failed: ${(error as Error).message}`, isError: true };
    }
  }
}
