// Per-tool integration policy: the stored curation map, the scope and
// class gate, and the acting-identity override rule.

import type { IntegrationToolInfo, IntegrationTurn } from "./plugins.js";
import type { McpTool } from "./mcp.js";
import type { JsonObject } from "./shared.js";
import { classRank, isToolClass, type ToolClass } from "../platform/domain/tool-class.js";

/** Per-tool approval value forcing a durable approval prompt on every call. */
export const TOOL_APPROVAL_ALWAYS_ASK = "always_ask";

/** Per-tool approval value letting every call flow without an approval
 *  prompt — the chat's approval mode and the chat owner's account policy
 *  never gate it (the org's call: the tool is non-sensitive). */
export const TOOL_APPROVAL_ALWAYS_ALLOW = "always_allow";

/** One tool's admin curation as stored on the integration row's config:
 *  `config.tools[<raw tool name>] = { enabled, approval, class? }`. Absent from the
 *  stored config: adapter-bound (built-in connector) → enabled, follow user
 *  policy; MCP-bound (live discovery) → disabled — nothing is exposed that
 *  the admin did not approve. Unknown approval values read as the default. */
export function toolCurate(
  rowConfig: JsonObject,
  mcp: boolean,
  rawTool: string,
): { enabled: boolean; alwaysAsk: boolean; alwaysAllow: boolean; cls: ToolClass | null } {
  const tools = rowConfig["tools"];
  const stored =
    tools !== null && typeof tools === "object" && !Array.isArray(tools) ? (tools as JsonObject)[rawTool] : undefined;
  if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) {
    const c = stored as JsonObject;
    return {
      enabled: typeof c["enabled"] === "boolean" ? c["enabled"] : !mcp,
      alwaysAsk: c["approval"] === TOOL_APPROVAL_ALWAYS_ASK,
      alwaysAllow: c["approval"] === TOOL_APPROVAL_ALWAYS_ALLOW,
      cls: mcp && isToolClass(c["class"]) ? c["class"] : null,
    };
  }
  return { enabled: !mcp, alwaysAsk: false, alwaysAllow: false, cls: null };
}

const READ_VERB =
  /^(get|list|search|read|fetch|find|query|describe|lookup|show|view|count|check|retrieve|browse)([_.-]|[A-Z]|$)/i;

/** The class Guild suggests for a discovered MCP tool: the server's own
 *  hints first (read-only → read, destructive → write), then a read verb at
 *  the start of its name; anything else is write, so a tool nobody classed
 *  never runs under a read-only policy by default. */
export function suggestedToolClass(tool: Pick<McpTool, "name" | "annotations">): ToolClass {
  if (tool.annotations?.readOnlyHint === true) return "read";
  if (tool.annotations?.destructiveHint === true) return "write";
  return READ_VERB.test(tool.name) ? "read" : "write";
}

/** The class a registry manifest declares for one MCP tool, or null when
 *  it names none (a catalog stub ships no tool list). */
function declaredMcpClass(manifest: JsonObject | null, rawTool: string): ToolClass | null {
  const tools = manifest?.["tools"];
  if (tools === null || typeof tools !== "object" || Array.isArray(tools)) return null;
  const classes = (tools as JsonObject)["classes"];
  if (classes === null || typeof classes !== "object" || Array.isArray(classes)) return null;
  const declared = (classes as JsonObject)[rawTool];
  return isToolClass(declared) ? declared : null;
}

/** The class an MCP tool runs under: the admin's curated class when set,
 *  else the registry manifest's declaration, else the class suggested from
 *  the live tool's hints and name. A compiled-in tool's class is its code
 *  declaration only. */
export function mcpToolClass(
  rowConfig: JsonObject,
  manifest: JsonObject | null,
  tool: Pick<McpTool, "name" | "annotations">,
): ToolClass {
  return (
    toolCurate(rowConfig, true, tool.name).cls ?? declaredMcpClass(manifest, tool.name) ?? suggestedToolClass(tool)
  );
}

/** What one Turn may reach: the Trait tools its Agent's built-in allowlist
 *  names (`all` for `tools_mode = all`) and the Agent's Integration entries
 *  with their class ceilings. */
export interface IntegrationScope {
  traits: ReadonlySet<string> | "all";
  integrations: ReadonlyMap<string, ToolClass>;
}

/** A scope with no Integration: Trait tools only. */
export const TRAITS_ONLY: IntegrationScope = { traits: "all", integrations: new Map() };

/** The ceiling a scope gives one tool. A Trait tool is Guild's generic tool
 *  (web search, web fetch): the built-in allowlist decides it, whichever
 *  Integration serves it. Any other tool needs its Integration in the
 *  Agent's list. */
export function scopeCeiling(scope: IntegrationScope, slug: string, info: IntegrationToolInfo): ToolClass | null {
  if (info.trait !== undefined) {
    const named = scope.traits === "all" || scope.traits.has(info.spec.name);
    return named ? (isToolClass(info.class) ? info.class : "read") : null;
  }
  return scope.integrations.get(slug) ?? null;
}

/** Whether one resolved tool is offered: per-tool curation first (a
 *  disabled tool is invisible), then `admin`-class tools are admin-only,
 *  then the tool's class must fall within the ceiling. Guards built-in and
 *  MCP tools alike. */
export function toolOffered(
  turn: IntegrationTurn,
  info: IntegrationToolInfo,
  ceiling: ToolClass | null,
  role: string,
): boolean {
  if (!toolCurate(turn.rowConfig, turn.executor === "mcp", info.raw).enabled) return false;
  if (info.class === "admin" && role !== "admin") return false;
  return ceiling !== null && classRank(info.class) <= classRank(ceiling);
}

/** Resolves the acting identity for one call: no override acts as the
 *  caller's own mapped identity (null when there is none); an override to a
 *  different identity is admin-only. */
export function resolveActingAs(
  callerEmail: string | null,
  override: string | null | undefined,
  isAdmin: boolean,
): string | null {
  if (override === null || override === undefined) return callerEmail;
  if (override === callerEmail || isAdmin) return override;
  throw new Error("acting_as override is admin-only");
}
