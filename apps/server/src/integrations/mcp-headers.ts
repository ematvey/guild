// The request headers of an org MCP integration. An integration row's
// `config.mcp` carries the server URL, an optional header map, and whether
// Guild's identity envelope rides along:
//
//   mcp: {
//     url: "https://mcp.example.com/mcp",
//     headers: { "Authorization": "{authorization}" },   // optional
//     envelope: true,                                     // default true
//   }
//
// A header value is a template: each `{name}` is replaced by the stored
// secret of that name, so credentials stay in the encrypted secret store
// and the row config holds only their shape. With a header map, secrets
// reach the server only through it; without one, every secret rides as
// `x-guild-secret-<name>` (the Guild-native plugin convention).

import type { JsonObject } from "./shared.js";

export interface McpEnvelope {
  callId: string;
  orgId: string;
  caller: string | null;
  actingAs: string | null;
}

const SECRET_NAME = /^[a-z0-9_-]+$/;
const PLACEHOLDER = /\{([a-z0-9_-]+)\}/g;

function mcpBlock(rowConfig: JsonObject): JsonObject {
  const mcp = rowConfig["mcp"];
  return mcp !== null && typeof mcp === "object" && !Array.isArray(mcp) ? (mcp as JsonObject) : {};
}

/** The header map of an MCP row config: header name to value template. */
export function mcpHeaderTemplates(rowConfig: JsonObject): Record<string, string> | null {
  const headers = mcpBlock(rowConfig)["headers"];
  if (headers === null || typeof headers !== "object" || Array.isArray(headers)) return null;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers as JsonObject)) {
    if (typeof value === "string") out[name] = value;
  }
  return out;
}

/** The secret a header's value is stored under: the header name in
 *  lowercase with every other character folded to `_`
 *  (`X-Api-Key` → `x_api_key`). */
export function headerSecretName(header: string): string {
  return header
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

/** Secret names a header map's templates reference. */
export function templateSecretNames(templates: Record<string, string>): string[] {
  const names = new Set<string>();
  for (const value of Object.values(templates)) {
    for (const match of value.matchAll(PLACEHOLDER)) names.add(match[1]!);
  }
  return [...names];
}

/** Validates a header map: header names must be valid HTTP tokens and not
 *  shadow the transport's own headers or the identity envelope. */
export function validateHeaderTemplates(templates: Record<string, string>): void {
  for (const name of Object.keys(templates)) {
    if (!/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/.test(name)) throw new Error(`header name ${name} is not a valid HTTP header`);
    const lower = name.toLowerCase();
    if (lower === "content-type" || lower === "accept" || lower === "mcp-session-id" || lower.startsWith("x-guild-")) {
      throw new Error(`header ${name} is set by Guild and cannot be configured`);
    }
  }
}

/** The headers one MCP request carries: the identity envelope (unless the
 *  row turns it off) and the credentials. A template whose secret is not
 *  stored is left out, never sent half-filled. */
export function mcpRequestHeaders(
  rowConfig: JsonObject,
  envelope: McpEnvelope,
  secrets: [string, string][],
): Record<string, string> {
  const headers: Record<string, string> = {};
  if (mcpBlock(rowConfig)["envelope"] !== false) {
    headers["x-guild-org"] = envelope.orgId;
    headers["x-guild-call-id"] = envelope.callId;
    if (envelope.caller !== null) headers["x-guild-caller"] = envelope.caller;
    if (envelope.actingAs !== null) headers["x-guild-acting-as"] = envelope.actingAs;
  }
  const templates = mcpHeaderTemplates(rowConfig);
  if (templates === null) {
    for (const [name, value] of secrets) {
      if (!SECRET_NAME.test(name)) continue; // undeclarable name — never leak it by other means
      headers[`x-guild-secret-${name}`] = value;
    }
    return headers;
  }
  const values = new Map(secrets);
  for (const [name, template] of Object.entries(templates)) {
    let complete = true;
    const rendered = template.replace(PLACEHOLDER, (_whole, secretName: string) => {
      const value = values.get(secretName);
      if (value === undefined) complete = false;
      return value ?? "";
    });
    if (complete) headers[name] = rendered;
  }
  return headers;
}
