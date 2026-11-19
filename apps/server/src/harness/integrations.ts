// The integrations chat runtime (server_tool_step + the plugin turn
// machinery): per turn the enabled
// plugins of the conversation's org resolve into a snapshot, one dynamic
// per-conversation registry extension carries their tools (the Guild-provided
// `{slug}_list_tools` / `{slug}_guide` disclosure pair plus the connector
// tools), the system prompt gains the integrations index, and every call
// runs the policy filter, the approval envelope, and the audit event.
//
// Dynamic registration: the registry is
// process-global and extensions are static code, so the per-conversation extension
// is (re)installed at each turn start (registry.install replaces in place)
// and each conversation is configured with an exact extension selection +
// scope-filtered tool allow-list (`pi.agent`). The tool calls ride the
// existing durable turn stream untouched.

import type { ChatStore } from "../platform/store/chats.js";
import type { Context } from "@earendil-works/chord";
import { toolSchema, toolDetails } from "./tool-schema.js";
import { readGuideText } from "./guide-text.js";
import type {
  PromptSection,
  Registry,
  ToolExecutionApi,
  ToolExecutionResult,
  ToolRegistration,
} from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import type { ToolGroup } from "./codemode-namespaces.js";
import type { Logger } from "pino";
import type { PlatformPool } from "../platform/db.js";
import type { EventStore } from "../platform/store/events.js";
import type { ToolArtifactStore } from "../platform/store/tool-artifacts.js";
import type { ObjectStore } from "../platform/s3.js";
import { writeIntoEnv } from "./chat-files.js";
import { auditError, callPlugin } from "../integrations/execute.js";
import type { JsonObject, ToolOutcome } from "../integrations/shared.js";
import type { IntegrationGateway } from "../integrations/plugins.js";
import {
  namespacedTool,
  resolveIntegrations,
  unnamespacedTool,
  type IntegrationToolInfo,
  type IntegrationTurn,
} from "../integrations/plugins.js";
import { scopeCeiling, toolCurate, toolOffered, TRAITS_ONLY, type IntegrationScope } from "../integrations/policy.js";
import { IntegrationAccessStore } from "../platform/store/integration-access.js";

/** The coding tools every chat carries (pi-durable CodingTools); the
 *  per-conversation tool allow-list must name them explicitly. */
export const CODING_TOOL_NAMES = ["read", "write", "edit", "bash"] as const;

export interface IntegrationCaller {
  userId: string;
  email: string | null;
  role: string;
}

interface TurnSnapshot {
  orgId: string;
  chatId: string;
  turns: IntegrationTurn[];
  caller: IntegrationCaller | null;
  scope: IntegrationScope;
}

/** Whether a snapshot's Turn may call one tool. */
function offered(snapshot: TurnSnapshot, turn: IntegrationTurn, info: IntegrationToolInfo): boolean {
  return toolOffered(turn, info, scopeCeiling(snapshot.scope, turn.slug, info), snapshot.caller?.role ?? "member");
}

/** The narrow gateway slice the runtime needs (structurally the
 *  GatewayCtx). Secrets are re-resolved at call time — snapshots never
 *  carry values. */

export interface IntegrationsRuntimeDeps {
  gateway: IntegrationGateway;
  events: EventStore;
  artifacts: ToolArtifactStore;
  /** Object store for guide bundles + spilled artifacts; absent in tests
   *  without one — the guide degrades, the spill falls back inline. */
  objects: ObjectStore | undefined;
  pool: PlatformPool;
  /** The chat's org (the per-turn snapshot's tenant). */
  chats: Pick<ChatStore, "orgOf" | "ownerOf">;
  log: Logger;
  chatOfConversation(conversationId: number): Promise<string | null>;
  /** The reach of a chat's Agent; defaults to the agent row read. */
  scopeOf?(chatId: string): Promise<IntegrationScope>;
}

/** The reach of the Agent a chat belongs to: its Trait allowlist and its
 *  Integration entries. A chat with no Agent reaches Trait tools only. */
export async function integrationScopeForChat(
  access: Pick<IntegrationAccessStore, "chatAgentReach">,
  chatId: string,
): Promise<IntegrationScope> {
  const reach = await access.chatAgentReach(chatId);
  if (reach === null) return TRAITS_ONLY;
  return {
    traits: reach.tools_mode === "all" ? "all" : new Set(reach.tools),
    integrations: new Map(reach.entries.map((entry) => [entry.slug, entry.ceiling])),
  };
}

/** The system-prompt index line for one enabled integration (spec §7.1). */
function indexLine(turn: IntegrationTurn): string {
  return `Integration ${turn.slug}: ${turn.description} — call ${namespacedTool(turn.slug, "list_tools")} to discover its tools.`;
}

/** The Guild-provided auto tool names (spec §7.2/§7.3). */
function autoToolNames(turn: IntegrationTurn): [string, string] {
  return [namespacedTool(turn.slug, "list_tools"), namespacedTool(turn.slug, "guide")];
}

/** Recognizes an auto-tool call: `<slug>_list_tools` / `<slug>_guide`
 *  (legacy `int_<slug>_…` names tolerated). */
// coherence:seam owner=@maintainer until=2027-01-31 reason="shipped clients may still send the int_ prefix"
function parseAutoTool(
  turns: IntegrationTurn[],
  name: string,
): { index: number; kind: "list_tools" | "guide" } | undefined {
  const stripped = name.startsWith("int_") ? name.slice(4) : name;
  for (const [index, turn] of turns.entries()) {
    const [list, guide] = autoToolNames(turn);
    if (stripped === list) return { index, kind: "list_tools" };
    if (stripped === guide) return { index, kind: "guide" };
  }
  return undefined;
}

/** The plugin turn + tool a wire tool name resolves against — the
 *  execution gate and the audit share this matcher (legacy-prefixed names
 *  tolerated). */
// coherence:seam owner=@maintainer until=2027-01-31 reason="shipped clients may still send the int_ prefix"
function integrationTarget(
  turns: IntegrationTurn[],
  callName: string,
): { turn: IntegrationTurn; info: IntegrationToolInfo } | undefined {
  for (const turn of turns) {
    const info = turn.tools.find((t) => toolMatches(turn.slug, t, callName));
    if (info !== undefined) return { turn, info };
  }
  return undefined;
}

/** Whether a plugin tool answers a wire tool name: the declared name, the
 *  provider's raw name (a trait tool answers both), or the slug-namespaced
 *  shape a shipped client may still send. */
// coherence:seam owner=@maintainer until=2027-01-31 reason="shipped clients may still send the int_ prefix"
function toolMatches(slug: string, info: IntegrationToolInfo, callName: string): boolean {
  if (info.spec.name === callName || info.raw === callName) return true;
  return unnamespacedTool(slug, callName) === info.raw;
}

/** The approval-gate consultation surface (harness/integrations.ts
 *  IntegrationsRuntime implements it). "ask" = the card is forced
 *  (always_ask curation); "skip" = the call flows without a gate
 *  (read-class tools, or an always_allow curation — the org grants the
 *  tool past the chat's approval mode and the user policy); "policy" = the
 *  call falls through to the chat's approval mode (full_access flows, ask
 *  gates). */
export type IntegrationGateClassification = "skip" | "ask" | "policy" | undefined;

/** The approval-gate consultation surface (harness/integrations.ts
 *  IntegrationsRuntime implements it). */
export interface IntegrationGate {
  gateDecision(conversationId: number, callName: string, signal?: AbortSignal): Promise<IntegrationGateClassification>;
  /** Performance lint only; an approval exemption does not establish a read. */
  isReadCall(conversationId: number, callName: string, args: Record<string, unknown>): boolean;
}

/** The turn-start preparation a conversation is configured with. */
export interface TurnPreparation {
  /** The extensions to select in addition to the base (configure) — the
   *  per-conversation integration extension. */
  extensions: readonly Extension<ToolRegistration>[];
  /** The tool objects for the conversation's allow-list (configure). */
  tools: readonly ToolRegistration[];
}

export class IntegrationsRuntime {
  /** Declarations remain stable until the next explicit provisioning. */
  private readonly snapshots = new Map<number, TurnSnapshot>();
  /** Every integration tool name this runtime has ever registered — the
   *  cheap gate-classifier short-circuit for coding tools. */
  private readonly knownToolNames = new Set<string>();

  private readonly access: IntegrationAccessStore;

  constructor(
    private readonly deps: IntegrationsRuntimeDeps,
    private readonly registry: Registry<ToolRegistration>,
  ) {
    this.access = new IntegrationAccessStore(deps.pool);
  }

  extensionName(orgId: string, conversationId?: number): string {
    return `guild-integrations:${orgId}${conversationId === undefined ? "" : `:${conversationId}`}`;
  }

  forget(conversationId: number): void {
    const snapshot = this.snapshots.get(conversationId);
    if (snapshot) {
      const extension = this.registry.snapshot().extension(this.extensionName(snapshot.orgId, conversationId));
      if (extension) this.registry.uninstall(extension);
    }
    this.snapshots.delete(conversationId);
  }

  private warn(message: string): void {
    this.deps.log.warn(message);
  }

  /** Resolve the desired tool surface before admission or resume. Empty
   * selections clear persisted tools; transient resolution failures propagate.
   * The chat's Agent decides the reach: an Integration outside it, or with no
   * offered tool, disappears entirely, and an Integration's discovery list
   * shows only the tools the Turn may call. */
  async prepareTurn(conversationId: number, chatId: string, orgId: string): Promise<TurnPreparation> {
    let resolved: IntegrationTurn[] = [];
    try {
      resolved = await resolveIntegrations(this.deps.gateway, orgId, (m) => this.warn(m));
    } catch (error) {
      this.warn(`integrations resolve failed: ${(error as Error).message}`);
      throw error;
    }
    const [caller, scope] = await Promise.all([this.chatCaller(chatId), this.scopeOf(chatId)]);
    const draft: TurnSnapshot = { orgId, chatId, turns: [], caller, scope };
    const turns = resolved
      .map((turn) => ({ ...turn, tools: turn.tools.filter((info) => offered(draft, turn, info)) }))
      .filter((turn) => turn.tools.length > 0);
    this.snapshots.set(conversationId, { ...draft, turns });
    if (turns.length === 0) {
      // Empty desired state must clear persisted choices, also after restart.
      return { extensions: [], tools: [] };
    }
    const extension = this.installOrgExtension(orgId, turns, conversationId);
    const tools: ToolRegistration[] = [];
    for (const turn of turns) {
      tools.push(this.listToolsTool(turn), this.guideTool(turn));
      for (const info of turn.tools) tools.push(this.integrationTool(info));
    }
    return { extensions: [extension], tools };
  }

  private scopeOf(chatId: string): Promise<IntegrationScope> {
    return this.deps.scopeOf?.(chatId) ?? integrationScopeForChat(this.access, chatId);
  }

  /** Resolve the chat owner's current role and acting identity. */
  private async chatCaller(chatId: string): Promise<IntegrationCaller | null> {
    try {
      const owner = await this.deps.chats.ownerOf(chatId);
      return owner === null ? null : { userId: owner.user_id, email: owner.email, role: owner.role };
    } catch (error) {
      this.warn(`chat caller resolution failed: ${(error as Error).message}`);
      throw error;
    }
  }

  /** Installs (or replaces in place) the org's integration extension: the
   *  Guild-provided disclosure pair per plugin plus every curated-enabled
   *  connector tool. Curated-off tools are not registered at all — not
   *  declared to the model and not callable. */
  private installOrgExtension(
    orgId: string,
    turns: IntegrationTurn[],
    conversationId: number,
  ): Extension<ToolRegistration> {
    const tools: ToolRegistration[] = [];
    for (const turn of turns) {
      tools.push(this.listToolsTool(turn), this.guideTool(turn));
      for (const info of turn.tools) {
        if (!toolCurate(turn.rowConfig, info.raw).enabled) continue;
        tools.push(this.integrationTool(info));
        this.knownToolNames.add(info.spec.name);
      }
    }
    const runtime = this;
    const section: PromptSection<ToolRegistration> = {
      key: "integrations",
      tag: false,
      async render(input) {
        const snapshot = await runtime.snapshotFor(Number(input.conversationId));
        const snapshotTurns = snapshot?.turns ?? [];
        if (snapshotTurns.length === 0) return undefined;
        return `Enabled integrations (their tools are discovered on demand):\n${snapshotTurns
          .map(indexLine)
          .map((line) => `- ${line}`)
          .join("\n")}`;
      },
    };
    const extension: Extension<ToolRegistration> = {
      name: this.extensionName(orgId, conversationId),
      tools,
      sections: [section],
    };
    this.registry.install(extension);
    return extension;
  }

  private static toolRegistration(
    spec: IntegrationToolInfo["spec"],
    execute: (
      args: JsonObject,
      api: ToolExecutionApi,
      context: Context,
    ) => Promise<{ content: string; isError: boolean; meta?: unknown }>,
  ): ToolRegistration {
    const registration = {
      name: spec.name,
      description: spec.description,
      parameters: toolSchema(spec.parameters),
      callers: ["tools"] as const,
      replay: "unsafe" as const,
      async execute(args: unknown, api: ToolExecutionApi, context: Context): Promise<ToolExecutionResult> {
        context.abortSignal?.throwIfAborted();
        const outcome = await execute((args ?? {}) as JsonObject, api, context);
        context.abortSignal?.throwIfAborted();
        // The tool-owned widget payload rides the details' reserved
        // `guild_meta` key — the bridge maps it onto the tool_result event.
        return {
          isError: outcome.isError,
          output: [{ type: "text", text: outcome.content }],
          ...(outcome.meta !== undefined && outcome.meta !== null
            ? { details: toolDetails({ guild_meta: outcome.meta }) }
            : {}),
        };
      },
    } satisfies ToolRegistration;
    return registration;
  }

  /** `{slug}_list_tools`: the tool specs the Turn may call, as compact JSON. */
  private listToolsTool(turn: IntegrationTurn): ToolRegistration {
    return IntegrationsRuntime.toolRegistration(
      {
        name: namespacedTool(turn.slug, "list_tools"),
        description: `List the tools of the ${turn.slug} integration that you may call, with JSON schemas.`,
        parameters: { type: "object", properties: {} },
      },
      async (_args, api) => {
        const snapshot = await this.snapshotFor(Number(api.conversationId));
        const snapshotTurn = snapshot?.turns.find((t) => t.slug === turn.slug);
        if (snapshotTurn === undefined) {
          return { content: `integration ${turn.slug} is not enabled for this conversation`, isError: true };
        }
        const specs = snapshotTurn.tools
          .filter((info) => offered(snapshot!, snapshotTurn, info))
          .map((info) => ({
            name: info.spec.name,
            description: info.spec.description,
            parameters: info.spec.parameters,
          }));
        return { content: JSON.stringify(specs), isError: false };
      },
    );
  }

  /** `{slug}_guide`: the usage guide (SKILL.md/README.md) of the
   *  integration's approved cookbook bundle, when one is installed. */
  private guideTool(turn: IntegrationTurn): ToolRegistration {
    return IntegrationsRuntime.toolRegistration(
      {
        name: namespacedTool(turn.slug, "guide"),
        description: `Return the usage guide (SKILL.md) for the ${turn.slug} integration.`,
        parameters: { type: "object", properties: {} },
      },
      async (_args, api) => {
        const snapshot = await this.snapshotFor(Number(api.conversationId));
        const snapshotTurn = snapshot?.turns.find((t) => t.slug === turn.slug);
        if (snapshotTurn === undefined || snapshotTurn.executor !== "mcp") {
          return { content: `integration ${turn.slug} has no guide`, isError: false };
        }
        const guide = await this.fetchGuide(snapshot!.orgId, turn.slug).catch(() => null);
        return { content: guide ?? `integration ${turn.slug} has no guide`, isError: false };
      },
    );
  }

  /** The conversation's codemode namespaces: one per enabled integration,
   *  holding its discovery tools and the tools the Turn may call. */
  async toolGroups(conversationId: number): Promise<ToolGroup[]> {
    const snapshot = await this.snapshotFor(conversationId);
    if (snapshot === undefined) return [];
    return snapshot.turns.map((turn) => {
      const [listTools, guide] = autoToolNames(turn);
      return {
        name: turn.slug,
        description: turn.description,
        ...(turn.executor === "mcp" ? { instructions: `Usage guide: \`await tools.${guide}()\`.` } : {}),
        tools: [listTools, guide, ...turn.tools.map((info) => info.spec.name)],
      };
    });
  }

  private integrationTool(info: IntegrationToolInfo): ToolRegistration {
    return IntegrationsRuntime.toolRegistration(info.spec, async (args, api, context) => {
      return this.executeToolCall(api, info.spec.name, args, context);
    });
  }

  /** The conversation's turn snapshot: the turn-start cache, or a live
   *  resolve (restart recovery — a turn re-running its calls after a
   *  process restart re-derives them). Orgs without integrations resolve
   *  to an empty snapshot so the cheap checks never repeat the DB read. */
  private async snapshotFor(conversationId: number): Promise<TurnSnapshot | undefined> {
    const cached = this.snapshots.get(conversationId);
    if (cached !== undefined) return cached;
    const chatId = await this.deps.chatOfConversation(conversationId);
    if (chatId === null) return undefined;
    let orgId: string | null = null;
    try {
      orgId = await this.deps.chats.orgOf(chatId);
    } catch {
      orgId = null;
    }
    if (orgId === null) return undefined;
    let turns: IntegrationTurn[] = [];
    try {
      turns = await resolveIntegrations(this.deps.gateway, orgId, (m) => this.warn(m));
    } catch {
      turns = [];
    }
    const [caller, scope] = await Promise.all([this.chatCaller(chatId), this.scopeOf(chatId)]);
    const snapshot: TurnSnapshot = { orgId, chatId, turns, caller, scope };
    this.snapshots.set(conversationId, snapshot);
    if (turns.length > 0) this.installOrgExtension(orgId, turns, conversationId);
    return snapshot;
  }

  /** Declarations stay stable until provisioning; authorization is always fresh. */
  private async authorizedSnapshot(conversationId: number): Promise<TurnSnapshot | undefined> {
    const declared = await this.snapshotFor(conversationId);
    if (!declared) return undefined;
    const turns = await resolveIntegrations(this.deps.gateway, declared.orgId, (message) => this.warn(message));
    const [caller, scope] = await Promise.all([this.chatCaller(declared.chatId), this.scopeOf(declared.chatId)]);
    return { ...declared, turns, caller, scope };
  }

  /** The approval-gate classification of one call: Guild-provided
   *  disclosure tools, read-class
   *  tools, and always_allow-curated tools flow without a gate; an
   *  `always_ask` curation or a write-class tool forces the card / follows
   *  the chat's approval mode — org governance wins over the chat's
   *  approval mode in both directions. `undefined` = not an integration
   *  tool (the generic policy applies). */
  async gateDecision(conversationId: number, callName: string): Promise<IntegrationGateClassification> {
    // Cheap path: a name this runtime never registered and no auto-tool
    // shape cannot be an integration tool — coding tools pay no resolve.
    // coherence:seam owner=@maintainer until=2027-01-31 reason="shipped clients may still send the int_ prefix"
    if (!this.knownToolNames.has(callName) && !/^(int_)?[a-z0-9][a-z0-9-]*_[a-z0-9_]+$/.test(callName)) {
      return undefined;
    }
    const snapshot = await this.authorizedSnapshot(conversationId);
    if (snapshot === undefined || snapshot.turns.length === 0) return undefined;
    if (parseAutoTool(snapshot.turns, callName) !== undefined) return "skip";
    const target = integrationTarget(snapshot.turns, callName);
    if (target === undefined) return undefined;
    const { turn, info } = target;
    const curation = toolCurate(turn.rowConfig, info.raw);
    if (curation.alwaysAsk) return "ask";
    if (curation.alwaysAllow) return "skip";
    return info.class === "read" ? "skip" : "policy";
  }

  /** The admitted tool declaration supplies effects for the script lint.
   * Actual nested execution still rechecks access and approvals. */
  isReadCall(conversationId: number, callName: string, args: Record<string, unknown>): boolean {
    const snapshot = this.snapshots.get(conversationId);
    if (!snapshot) return false;
    const target = integrationTarget(snapshot.turns, callName);
    if (!target) return false;
    if (target.info.class === "read") return true;
    // The generic HubSpot tool has a write ceiling, but these operations
    // only read. Unknown or dynamic methods and POST paths stay unclassified.
    if (target.turn.slug !== "hubspot" || target.info.raw !== "api") return false;
    if (args.method === undefined && !("method" in args)) return true;
    if (args.method === "GET") return true;
    return (
      args.method === "POST" &&
      typeof args.path === "string" &&
      /^\/crm\/v3\/objects\/[A-Za-z0-9_-]+\/search$/.test(args.path)
    );
  }

  /** Executes one integration tool call: the policy filter, the plugin dispatch, the artifact spill, and the audit
   *  event. A failure is a tool RESULT the model sees, never a thrown
   *  error. */
  private async executeToolCall(
    api: ToolExecutionApi,
    callName: string,
    args: JsonObject,
    context: Context,
  ): Promise<{ content: string; isError: boolean; meta?: unknown }> {
    const conversationId = Number(api.conversationId);
    const callId = api.callId;
    const signal = context.abortSignal;
    const snapshot = await this.authorizedSnapshot(conversationId);
    const turns = snapshot?.turns ?? [];
    // Guild-provided disclosure tools (never sent to a connector).
    const auto = parseAutoTool(turns, callName);
    if (auto !== undefined) {
      // Handled by the dedicated tools; unreachable here, but fail closed.
      return { content: `unknown server tool ${callName}`, isError: true };
    }
    const target = integrationTarget(turns, callName);
    if (target === undefined || snapshot === undefined) {
      return { content: `unknown server tool ${callName}`, isError: true };
    }
    const { turn, info } = target;
    if (!offered(snapshot, turn, info)) {
      return { content: "not permitted by integration policy", isError: true };
    }
    const raw = info.raw;
    const started = Date.now();
    const outcome = await callPlugin(
      this.deps.gateway,
      turn,
      raw,
      args,
      {
        orgId: snapshot.orgId,
        callerId: snapshot.caller?.userId ?? snapshot.chatId,
        callId,
        actingAs: snapshot.caller?.email ?? null,
      },
      signal,
    )
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    const ok = outcome.ok;
    // Journaled audit of the call's identity (spec §8) — best-effort. Auto
    // tools are disclosure-only and never audited.
    try {
      await this.deps.events.emit(snapshot.orgId, "integration.tool_called", {
        slug: turn.slug,
        tool: raw,
        caller: snapshot.caller?.userId ?? null,
        acting_as: snapshot.caller?.email ?? null,
        ok,
        via: "chat",
        ms: Date.now() - started,
        error: outcome.ok ? null : auditError(outcome.error),
      });
    } catch (error) {
      this.warn(`integration audit emit failed: ${(error as Error).message}`);
    }
    if (!ok) {
      return { content: `web tool failed: ${(outcome.error as Error).message}`, isError: true };
    }
    return this.deliver(api, raw, outcome.value, context);
  }

  /** The file sink: bytes a tool carries are written where the call names
   *  them, so the model reads them with the ordinary tools. A tool without
   *  bytes passes its content through unchanged. */
  private async deliver(
    api: ToolExecutionApi,
    rawTool: string,
    outcome: ToolOutcome,
    context: Context,
  ): Promise<{ content: string; isError: boolean; meta?: unknown }> {
    if (outcome.file !== undefined) {
      const env = api.env;
      if (env === undefined) return { content: outcome.content, isError: false, meta: outcome.meta };
      const written = await writeIntoEnv(env, outcome.file.path, outcome.file.bytes, context, {
        overwrite: true,
      });
      if (!written.ok) return { content: `${rawTool}: ${written.reason}`, isError: true };
      return {
        content: `Saved ${written.value.path} (${outcome.file.bytes.length} bytes)`,
        isError: false,
        meta: outcome.meta,
      };
    }
    return { content: outcome.content, isError: false, meta: outcome.meta };
  }

  /** Fetches and unpacks the guide body (SKILL.md, falling back to
   *  README.md) of one cookbook bundle through the approval gate
   *  (approved version + bundle hash) — unapproved content never reaches
   *  model context. */
  private async fetchGuide(orgId: string, slug: string): Promise<string | null> {
    const { objects, gateway } = this.deps;
    if (objects === undefined) return null;
    const approved = await gateway.registry.approvedBundle(orgId, "integration", slug);
    if (approved === null) return null;
    const [version, bundleSha256] = approved;
    const stored = await gateway.registry.getVersion(orgId, "integration", slug, version);
    if (stored.bundle_sha256 !== bundleSha256) return null;
    const skills = (stored.manifest ?? {}) as JsonObject;
    const skillList = skills["skills"];
    const first = Array.isArray(skillList) ? skillList.find((s): s is string => typeof s === "string") : undefined;
    if (first === undefined) return null;
    const skillApproved = await gateway.registry.approvedBundle(orgId, "skill", first);
    if (skillApproved === null) return null;
    const [skillVersion, skillSha256] = skillApproved;
    const skillStored = await gateway.registry.getVersion(orgId, "skill", first, skillVersion);
    if (skillStored.bundle_sha256 !== skillSha256) return null;
    const bytes = await objects.get(skillStored.object_key);
    return readGuideText(bytes);
  }
}

export { parseAutoTool, integrationTarget };
