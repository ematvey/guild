// Per-tool integration policy: the stored curation map, the role/class
// gate, and the acting-identity override rule.

import type { IntegrationToolInfo, IntegrationTurn } from "./plugins.js";
import type { JsonObject } from "./shared.js";
import { classRank, isToolClass } from "../platform/domain/tool-class.js";

/** Per-tool approval value forcing a durable approval prompt on every call. */
export const TOOL_APPROVAL_ALWAYS_ASK = "always_ask";

/** Per-tool approval value letting every call flow without an approval
 *  prompt — the chat's approval mode and the chat owner's account policy
 *  never gate it (the org's call: the tool is non-sensitive). */
export const TOOL_APPROVAL_ALWAYS_ALLOW = "always_allow";

/** One tool's admin curation as stored on the integration row's config:
 *  `config.tools[<raw tool name>] = { enabled, approval }`. Absent from the
 *  stored config: adapter-bound (built-in connector) → enabled, follow user
 *  policy; MCP-bound (live discovery) → disabled — nothing is exposed that
 *  the admin did not approve. Unknown approval values read as the default. */
export function toolCurate(
  rowConfig: JsonObject,
  mcp: boolean,
  rawTool: string,
): { enabled: boolean; alwaysAsk: boolean; alwaysAllow: boolean } {
  const tools = rowConfig["tools"];
  const stored =
    tools !== null && typeof tools === "object" && !Array.isArray(tools) ? (tools as JsonObject)[rawTool] : undefined;
  if (stored !== null && typeof stored === "object" && !Array.isArray(stored)) {
    const c = stored as JsonObject;
    return {
      enabled: typeof c["enabled"] === "boolean" ? c["enabled"] : !mcp,
      alwaysAsk: c["approval"] === TOOL_APPROVAL_ALWAYS_ASK,
      alwaysAllow: c["approval"] === TOOL_APPROVAL_ALWAYS_ALLOW,
    };
  }
  return { enabled: !mcp, alwaysAsk: false, alwaysAllow: false };
}

/** Classes one role may call. Default policy: member read-only, admin
 *  everything; a stored `tool_policy` tightens or reshapes per role, never
 *  past the manifest. */
function allowedClasses(rowConfig: JsonObject, role: string): string[] {
  const policy = rowConfig["tool_policy"];
  if (policy !== null && typeof policy === "object" && !Array.isArray(policy)) {
    const tp = (policy as JsonObject)[role];
    if (Array.isArray(tp)) {
      // A stored policy entry replaces the default for that role — an empty
      // list allows nothing.
      return tp.filter((v): v is string => typeof v === "string").filter(isToolClass);
    }
  }
  return role === "admin" ? ["read", "write", "admin"] : ["read"];
}

/** Whether one resolved tool may be called by `role`: per-tool curation
 *  first (a disabled tool is invisible), then the class rule (manifest class
 *  is the floor; a stored `tool_policy` tightens; admin-class tools are
 *  admin-only). Guards built-in and MCP tools
 *  alike. */
export function toolAllowed(turn: IntegrationTurn, info: IntegrationToolInfo, role: string): boolean {
  if (!toolCurate(turn.rowConfig, turn.executor === "mcp", info.raw).enabled) return false;
  if (info.class === "admin" && role !== "admin") return false;
  return allowedClasses(turn.rowConfig, role).some((c) => classRank(c) >= classRank(info.class));
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
