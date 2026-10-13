// The integrations chat runtime (server_tool_step + the plugin turn
// machinery): per turn the enabled
// plugins of the conversation's org resolve into a snapshot, one dynamic
// per-org registry extension carries their tools (the Guild-provided
// `{slug}_list_tools` / `{slug}_guide` disclosure pair plus the connector
// tools), the system prompt gains the integrations index, and every call
// runs the policy filter, the approval envelope, and the audit event.
//
// How dynamic registration maps onto pi-durable 1.0.1: the registry is
// process-global and extensions are static code, so the per-org extension
// is (re)installed at each turn start (registry.install replaces in place)
// and each conversation is configured with an exact extension selection +
// tool allow-list (`pi.agent`), role-filtered like the Rust disclosure
// filter. The tool calls ride the existing durable turn stream untouched.

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import type { PromptSection, Registry, ToolExecutionApi, ToolExecutionResult, ToolRegistration } from "@earendil-works/pi-durable";
import type { Extension } from "@earendil-works/pi-durable";
import type { TSchema } from "@earendil-works/pi-ai";
import type { Logger } from "pino";
import type { PlatformPool } from "../platform/db.js";
import type { EventStore } from "../platform/store/events.js";
import type { ToolArtifactStore } from "../platform/store/toolArtifacts.js";
import type { ObjectStore } from "../platform/s3.js";
import { artifactMeta, pointerText, spillArtifact } from "../chats/spill.js";
import { callPlugin, type ToolOutcome } from "../platform/integrations/execute.js";
import type { PluginGateway } from "../platform/integrations/plugins.js";
import {
  namespacedTool,
  resolvePlugins,
  toolAllowed,
  toolCurate,
  unnamespacedTool,
  type PluginToolInfo,
  type PluginTurn,
} from "../platform/integrations/plugins.js";

type Json = Record<string, unknown>;

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
  turns: PluginTurn[];
  caller: IntegrationCaller | null;
  at: number;
}

/** The narrow gateway slice the runtime needs (structurally the
 *  GatewayCtx). Secrets are re-resolved at call time — snapshots never
 *  carry values. */
export interface IntegrationGateway extends PluginGateway {}

export interface IntegrationsRuntimeDeps {
  gateway: IntegrationGateway;
  events: EventStore;
  artifacts: ToolArtifactStore;
  /** Object store for guide bundles + spilled artifacts; absent in tests
   *  without one — the guide degrades, the spill falls back inline. */
  objects: ObjectStore | undefined;
  pool: PlatformPool;
  log: Logger;
  chatOfConversation(conversationId: number): Promise<string | null>;
}

/** The system-prompt index line for one enabled integration (spec §7.1). */
function indexLine(turn: PluginTurn): string {
  return `Integration ${turn.slug}: ${turn.description} — call ${namespacedTool(turn.slug, "list_tools")} to discover its tools.`;
}

/** The Guild-provided auto tool names (spec §7.2/§7.3). */
function autoToolNames(turn: PluginTurn): [string, string] {
  return [namespacedTool(turn.slug, "list_tools"), namespacedTool(turn.slug, "guide")];
}

/** Recognizes an auto-tool call: `<slug>_list_tools` / `<slug>_guide`
 *  (legacy `int_<slug>_…` names tolerated). */
function parseAutoTool(turns: PluginTurn[], name: string): { index: number; kind: "list_tools" | "guide" } | undefined {
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
function pluginTarget(turns: PluginTurn[], callName: string): { turn: PluginTurn; info: PluginToolInfo } | undefined {
  for (const turn of turns) {
    const info = turn.tools.find((t) => toolMatches(turn.slug, t.spec.name, callName));
    if (info !== undefined) return { turn, info };
  }
  return undefined;
}

/** Whether a plugin tool spec answers a wire tool name — either exactly, or
 *  via the slug namespace (both sides stripped, legacy shape tolerated). */
function toolMatches(slug: string, specName: string, callName: string): boolean {
  if (specName === callName) return true;
  const s = unnamespacedTool(slug, specName);
  const c = unnamespacedTool(slug, callName);
  return s !== null && c !== null && s === c;
}

export type IntegrationGateClassification = "skip" | "ask" | undefined;

/** The approval-gate consultation surface (harness/integrations.ts
 *  IntegrationsRuntime implements it). */
export interface IntegrationGate {
  gateDecision(conversationId: number, callName: string): Promise<IntegrationGateClassification>;
}

/** The turn-start preparation a conversation is configured with. */
export interface TurnPreparation {
  action: "configure" | "clear" | "none";
  /** The extensions to select in addition to the base (configure) — the
   *  per-org integration extension. */
  extensions: readonly Extension<ToolRegistration>[];
  /** The tool objects for the conversation's allow-list (configure). */
  tools: readonly ToolRegistration[];
}

export class IntegrationsRuntime {
  /** Turn-start snapshots keyed by conversation id (the Rust journaled
   *  per-turn resolution — a turn's calls re-derive from its snapshot). */
  private readonly snapshots = new Map<number, TurnSnapshot>();
  /** Conversations whose `pi.agent` selection was configured (so a later
   *  turn with zero plugins can clear it again). */
  private readonly configured = new Map<number, string>();
  /** Every integration tool name this runtime has ever registered — the
   *  cheap gate-classifier short-circuit for coding tools. */
  private readonly knownToolNames = new Set<string>();
  /** The last installed org extension per org (the per-conversation
   *  selection references it through the change object). */
  private readonly orgExtensions = new Map<string, Extension<ToolRegistration>>();

  constructor(
    private readonly deps: IntegrationsRuntimeDeps,
    private readonly registry: Registry<ToolRegistration>,
  ) {}

  extensionName(orgId: string): string {
    return `guild-integrations:${orgId}`;
  }

  private warn(message: string): void {
    this.deps.log.warn(message);
  }

  /** Turn start (restate.rs ~1598): resolve this org's enabled plugins,
   *  cache the snapshot for the conversation's calls, install the org
   *  extension, and return the role-filtered tool names the model may
   *  call. `"clear"` resets a previously configured conversation whose org
   *  no longer carries integrations; `"none"` leaves it untouched. */
  async prepareTurn(conversationId: number, chatId: string, orgId: string): Promise<TurnPreparation> {
    let turns: PluginTurn[] = [];
    try {
      turns = await resolvePlugins(this.deps.gateway, orgId, (m) => this.warn(m));
    } catch (error) {
      this.warn(`integrations resolve failed, the turn continues without them: ${(error as Error).message}`);
      turns = [];
    }
    const caller = await this.chatCaller(chatId);
    this.snapshots.set(conversationId, { orgId, chatId, turns, caller, at: Date.now() });
    if (turns.length === 0) {
      // A previously configured conversation gets its selection cleared
      // when the org no longer carries integrations.
      if (this.configured.has(conversationId)) {
        this.configured.delete(conversationId);
        return { action: "clear", extensions: [], tools: [] };
      }
      return { action: "none", extensions: [], tools: [] };
    }
    const extension = this.installOrgExtension(orgId, turns);
    const tools: ToolRegistration[] = [];
    const role = caller?.role ?? "member";
    for (const turn of turns) {
      tools.push(this.listToolsTool(turn), this.guideTool(turn));
      for (const info of turn.tools) {
        if (toolAllowed(turn, info, role)) tools.push(this.connectorTool(info));
      }
    }
    return { action: "configure", extensions: [extension], tools };
  }

  /** The chat owner's identity (restate.rs resolves the caller at turn
   *  start; the chat owner is the caller). */
  private async chatCaller(chatId: string): Promise<IntegrationCaller | null> {
    try {
      const res = await this.deps.pool.query<{ id: string; email: string | null; role: string }>(
        "SELECT u.id, u.email, u.role FROM chats c JOIN users u ON u.id = c.user_id WHERE c.id = $1",
        [chatId],
      );
      const row = res.rows[0];
      return row ? { userId: row.id, email: row.email, role: row.role } : null;
    } catch (error) {
      this.warn(`chat caller resolution failed: ${(error as Error).message}`);
      return null;
    }
  }

  /** Installs (or replaces in place) the org's integration extension: the
   *  Guild-provided disclosure pair per plugin plus every curated-enabled
   *  connector tool. Curated-off tools are not registered at all — not
   *  declared to the model and not callable. */
  private installOrgExtension(orgId: string, turns: PluginTurn[]): Extension<ToolRegistration> {
    const tools: ToolRegistration[] = [];
    for (const turn of turns) {
      tools.push(this.listToolsTool(turn), this.guideTool(turn));
      for (const info of turn.tools) {
        const raw = unnamespacedTool(turn.slug, info.spec.name) ?? info.spec.name;
        if (!toolCurate(turn.rowConfig, turn.executor === "mcp", raw).enabled) continue;
        tools.push(this.connectorTool(info));
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
        return `Enabled integrations (their tools are discovered on demand):\n${snapshotTurns.map(indexLine).map((line) => `- ${line}`).join("\n")}`;
      },
    };
    const extension: Extension<ToolRegistration> = { name: this.extensionName(orgId), tools, sections: [section] };
    this.registry.install(extension);
    this.orgExtensions.set(orgId, extension);
    return extension;
  }

  private static toolRegistration(spec: PluginToolInfo["spec"], execute: (args: Json, callId: string, conversationId: number) => Promise<{ content: string; isError: boolean; meta?: unknown }>): ToolRegistration {
    const registration = {
      name: spec.name,
      description: spec.description,
      parameters: spec.parameters as TSchema,
      replay: "unsafe" as const,
      async execute(args: unknown, api: ToolExecutionApi): Promise<ToolExecutionResult> {
        const outcome = await execute((args ?? {}) as Json, api.callId, Number(api.conversationId));
        // The tool-owned widget payload rides the details' reserved
        // `guild_meta` key — the bridge maps it onto the tool_result event.
        return {
          isError: outcome.isError,
          content: [{ type: "text", text: outcome.content }],
          ...(outcome.meta !== undefined && outcome.meta !== null ? { details: { guild_meta: outcome.meta } as unknown as ToolExecutionResult["details"] } : {}),
        };
      },
    } as unknown as ToolRegistration;
    return registration;
  }

  /** `{slug}_list_tools`: the role-filtered tool specs as compact JSON. */
  private listToolsTool(turn: PluginTurn): ToolRegistration {
    return IntegrationsRuntime.toolRegistration({
      name: namespacedTool(turn.slug, "list_tools"),
      description: `List the tools of the ${turn.slug} integration that you may call, with JSON schemas.`,
      parameters: { type: "object", properties: {} },
    }, async (_args, _callId, conversationId) => {
      const snapshot = await this.snapshotFor(conversationId);
      const snapshotTurn = snapshot?.turns.find((t) => t.slug === turn.slug);
      if (snapshotTurn === undefined) {
        return { content: `integration ${turn.slug} is not enabled for this conversation`, isError: true };
      }
      const role = snapshot?.caller?.role ?? "member";
      const specs = snapshotTurn.tools
        .filter((info) => toolAllowed(snapshotTurn, info, role))
        .map((info) => ({ name: info.spec.name, description: info.spec.description, parameters: info.spec.parameters }));
      return { content: JSON.stringify(specs), isError: false };
    });
  }

  /** `{slug}_guide`: the usage guide (SKILL.md/README.md) of the
   *  integration's approved cookbook bundle, when one is installed. */
  private guideTool(turn: PluginTurn): ToolRegistration {
    return IntegrationsRuntime.toolRegistration({
      name: namespacedTool(turn.slug, "guide"),
      description: `Return the usage guide (SKILL.md) for the ${turn.slug} integration.`,
      parameters: { type: "object", properties: {} },
    }, async (_args, _callId, conversationId) => {
      const snapshot = await this.snapshotFor(conversationId);
      const snapshotTurn = snapshot?.turns.find((t) => t.slug === turn.slug);
      if (snapshotTurn === undefined || snapshotTurn.executor !== "mcp") {
        return { content: `integration ${turn.slug} has no guide`, isError: false };
      }
      const guide = await this.fetchGuide(snapshot!.orgId, turn.slug).catch(() => null);
      return { content: guide ?? `integration ${turn.slug} has no guide`, isError: false };
    });
  }

  private connectorTool(info: PluginToolInfo): ToolRegistration {
    return IntegrationsRuntime.toolRegistration(info.spec, async (args, callId, conversationId) => {
      return this.executeToolCall(conversationId, callId, info.spec.name, args);
    });
  }

  /** The conversation's turn snapshot: the turn-start cache, or a live
   *  resolve (restart recovery — a turn re-running its calls after a
   *  process restart re-derives them). Orgs without integrations resolve
   *  to an empty snapshot so the cheap checks never repeat the DB read. */
  private async snapshotFor(conversationId: number): Promise<TurnSnapshot | undefined> {
    const cached = this.snapshots.get(conversationId);
    if (cached !== undefined && Date.now() - cached.at < 10 * 60_000) return cached;
    const chatId = await this.deps.chatOfConversation(conversationId);
    if (chatId === null) return undefined;
    let orgId: string | null = null;
    try {
      const res = await this.deps.pool.query<{ org_id: string }>("SELECT org_id FROM chats WHERE id = $1", [chatId]);
      orgId = res.rows[0]?.org_id ?? null;
    } catch {
      orgId = null;
    }
    if (orgId === null) return undefined;
    let turns: PluginTurn[] = [];
    try {
      turns = await resolvePlugins(this.deps.gateway, orgId, (m) => this.warn(m));
    } catch {
      turns = [];
    }
    const caller = await this.chatCaller(chatId);
    const snapshot: TurnSnapshot = { orgId, chatId, turns, caller, at: Date.now() };
    this.snapshots.set(conversationId, snapshot);
    if (turns.length > 0) this.installOrgExtension(orgId, turns);
    return snapshot;
  }

  /** The approval-gate classification of one call (restate.rs
   *  server_tool_step's gate): Guild-provided disclosure tools and
   *  read-class tools flow without a gate; an `always_ask` curation or a
   *  write-class tool forces the card — org governance wins over the chat's
   *  approval mode. `undefined` = not an integration tool (the generic
   *  policy applies). */
  async gateDecision(conversationId: number, callName: string): Promise<"skip" | "ask" | undefined> {
    // Cheap path: a name this runtime never registered and no auto-tool
    // shape cannot be an integration tool — coding tools pay no resolve.
    if (!this.knownToolNames.has(callName) && !/^(int_)?[a-z0-9][a-z0-9-]*_[a-z0-9_]+$/.test(callName)) {
      return undefined;
    }
    const snapshot = await this.snapshotFor(conversationId);
    if (snapshot === undefined || snapshot.turns.length === 0) return undefined;
    if (parseAutoTool(snapshot.turns, callName) !== undefined) return "skip";
    const target = pluginTarget(snapshot.turns, callName);
    if (target === undefined) return undefined;
    const { turn, info } = target;
    const raw = unnamespacedTool(turn.slug, info.spec.name) ?? info.spec.name;
    const alwaysAsk = toolCurate(turn.rowConfig, turn.executor === "mcp", raw).alwaysAsk;
    if (alwaysAsk || info.class !== "read") return "ask";
    return "skip";
  }

  /** Executes one integration tool call (restate.rs server_tool_step): the
   *  policy filter, the plugin dispatch, the artifact spill, and the audit
   *  event. A failure is a tool RESULT the model sees, never a thrown
   *  error. */
  private async executeToolCall(conversationId: number, callId: string, callName: string, args: Json): Promise<{ content: string; isError: boolean; meta?: unknown }> {
    const snapshot = await this.snapshotFor(conversationId);
    const turns = snapshot?.turns ?? [];
    // Guild-provided disclosure tools (never sent to a connector).
    const auto = parseAutoTool(turns, callName);
    if (auto !== undefined) {
      // Handled by the dedicated tools; unreachable here, but fail closed.
      return { content: `unknown server tool ${callName}`, isError: true };
    }
    const target = pluginTarget(turns, callName);
    if (target === undefined || snapshot === undefined) {
      return { content: `unknown server tool ${callName}`, isError: true };
    }
    const { turn, info } = target;
    const role = snapshot.caller?.role ?? "member";
    if (!toolAllowed(turn, info, role)) {
      return { content: "not permitted by integration policy", isError: true };
    }
    const raw = unnamespacedTool(turn.slug, callName) ?? callName;
    const outcome = await callPlugin(this.deps.gateway, turn, raw, args, {
      orgId: snapshot.orgId,
      callerId: snapshot.caller?.userId ?? snapshot.chatId,
      callId,
      actingAs: snapshot.caller?.email ?? null,
    })
      .then((value) => ({ ok: true as const, value }))
      .catch((error: unknown) => ({ ok: false as const, error }));
    const ok = outcome.ok;
    // Journaled audit of the call's identity (spec §8) — best-effort, as
    // in Rust. Auto tools are disclosure-only and never audited.
    try {
      await this.deps.events.emit(snapshot.orgId, "integration.tool_called", {
        slug: turn.slug,
        tool: raw,
        caller: snapshot.caller?.userId ?? null,
        acting_as: snapshot.caller?.email ?? null,
        ok,
        via: "chat",
      });
    } catch (error) {
      this.warn(`integration audit emit failed: ${(error as Error).message}`);
    }
    if (!ok) {
      return { content: `web tool failed: ${(outcome.error as Error).message}`, isError: true };
    }
    return this.materialize(snapshot.chatId, callId, raw, outcome.value);
  }

  /** The artifact choke point (tool artifacts design): a tool-carried
   *  payload spills always and the content becomes the pointer text; a
   *  spill failure keeps the inline result — the outcome is never lost. */
  private async materialize(chatId: string, callId: string, rawTool: string, outcome: ToolOutcome): Promise<{ content: string; isError: boolean; meta?: unknown }> {
    const { artifacts, objects } = this.deps;
    if (outcome.artifact !== undefined) {
      if (objects === undefined) {
        return { content: outcome.content, isError: false, meta: outcome.meta };
      }
      try {
        const spilled = await spillArtifact(
          artifacts, objects, (await this.orgIdOfChat(chatId)) ?? "", chatId, callId, rawTool,
          outcome.artifact.filename, outcome.artifact.contentType, outcome.artifact.bytes,
        );
        return {
          content: pointerText(rawTool, spilled, outcome.artifact.contentType, null),
          isError: false,
          meta: artifactMeta(outcome.meta, spilled),
        };
      } catch (error) {
        this.deps.log.error({ err: error, tool: rawTool }, "artifact spill failed, keeping inline");
        return { content: outcome.content, isError: false, meta: outcome.meta };
      }
    }
    return { content: outcome.content, isError: false, meta: outcome.meta };
  }

  private async orgIdOfChat(chatId: string): Promise<string | null> {
    const res = await this.deps.pool.query<{ org_id: string }>("SELECT org_id FROM chats WHERE id = $1", [chatId]);
    return res.rows[0]?.org_id ?? null;
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
    const skills = (stored.manifest ?? {}) as Json;
    const skillList = skills["skills"];
    const first = Array.isArray(skillList) ? skillList.find((s): s is string => typeof s === "string") : undefined;
    if (first === undefined) return null;
    const skillApproved = await gateway.registry.approvedBundle(orgId, "skill", first);
    if (skillApproved === null) return null;
    const [skillVersion, skillSha256] = skillApproved;
    const skillStored = await gateway.registry.getVersion(orgId, "skill", first, skillVersion);
    if (skillStored.bundle_sha256 !== skillSha256) return null;
    const bytes = await objects.get(skillStored.object_key);
    return extractBundleText(bytes);
  }
}

/** Extracts SKILL.md (falling back to README.md) from a tar.gz bundle. */
function extractBundleText(bundle: Buffer): string | null {
  const dir = mkdtempSync(path.join(tmpdir(), "guild-guide-"));
  try {
    const tgz = path.join(dir, "bundle.tar.gz");
    writeFileSync(tgz, bundle);
    tar.x({ sync: true, gzip: true, cwd: dir, file: tgz });
    for (const name of ["SKILL.md", "README.md"]) {
      try {
        const text = readFileSync(path.join(dir, name), "utf8");
        if (text.trim() !== "") return text;
      } catch {
        // next candidate
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export { parseAutoTool, pluginTarget };
