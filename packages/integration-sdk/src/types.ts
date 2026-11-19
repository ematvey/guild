// The integration plugin contract. A plugin module's default export is one
// of two shapes, for a built-in compiled into the server and a published
// plugin bundle alike:
//   - a code plugin: a manifest (shop metadata, settings fields, tool
//     declarations, traits) and its validate, testConnection and execute
//     functions;
//   - an MCP plugin: a manifest naming a remote MCP server, the settings an
//     admin fills in and the headers they become. It carries no code; the
//     server discovers its tools live.

import type { JsonObject, ToolOutcome } from "./shared.js";

/** One admin-facing settings field (the shop's configure form schema). */
export interface IntegrationField {
  name: string;
  /** string | text | number | boolean | secret */
  kind: string;
  label: string | null;
  required: boolean;
  default: unknown;
  help: string | null;
  placeholder: string | null;
  /** Markdown: where an admin gets this value (a secret's console page,
   *  the scopes to grant). The setup page shows it beside the field. */
  obtain?: string | null;
}

/** One tool the integration contributes. `class` is the policy floor:
 *  read, write, or admin. */
export interface IntegrationToolDecl {
  name: string;
  class: "read" | "write" | "admin";
  description: string;
  /** JSON Schema object. */
  parameters: unknown;
}

/** A trait is a capability with a Guild-provided name and description; the
 *  integration supplies the implementation. The map value is the provider's
 *  own tool name. */
export type IntegrationTraits = Record<string, string>;

export interface IntegrationManifest {
  name: string;
  title: string;
  version: string;
  publisher: string;
  /** One line for the shop card. */
  summary: string;
  /** Markdown the agent reads about the integration; the people-facing
   *  landing page is the plugin's README.md. */
  description: string;
  docs_url: string | null;
  categories: string[];
  traits: IntegrationTraits;
  auth_kind: string;
  identity_key: string;
  fields: IntegrationField[];
  tools: IntegrationToolDecl[];
  /** Skill slugs that document this integration. The first one is what
   *  `<slug>_guide` returns; with none, the Turn has no guide tool. */
  skills?: readonly string[];
}

/** A plugin as its folder exports it. */
export interface IntegrationPlugin {
  manifest: IntegrationManifest;
  /** Rejects a broken row config before the tool surface is declared. */
  validate?(config: JsonObject): void;
  /** The shop's save gate: a probe against the would-be configuration. */
  testConnection(config: JsonObject, secrets: [string, string][]): Promise<void>;
  execute(
    config: JsonObject,
    tool: string,
    args: JsonObject,
    secrets: [string, string][],
    actingAs: string | null,
  ): Promise<ToolOutcome>;
}

/** A remote MCP server an MCP plugin wraps. Each `{name}` in a header
 *  value is replaced by the stored secret of that name; a header whose
 *  secret is not stored is not sent. */
export interface McpServer {
  url: string;
  headers?: Record<string, string>;
  /** Send Guild's `x-guild-*` identity headers. Default true; a
   *  third-party server should get false. */
  envelope?: boolean;
}

export interface McpIntegrationManifest {
  name: string;
  title: string;
  version: string;
  publisher: string;
  /** One line for the shop card. */
  summary: string;
  /** Markdown the agent reads about the integration; the people-facing
   *  landing page is the plugin's README.md. */
  description: string;
  docs_url: string | null;
  categories: string[];
  /** The settings form; secret-kind fields are what the header templates
   *  reference. */
  fields: IntegrationField[];
  mcp: McpServer;
  /** Classes for tools the server serves, by the server's tool name. A tool
   *  not named here takes the admin's choice, else the class its read-only
   *  and destructive hints and its name suggest. */
  tool_classes?: Record<string, "read" | "write" | "admin">;
  /** Skill slugs that document this server. The first one is what
   *  `<slug>_guide` returns; with none, the Turn has no guide tool. */
  skills?: readonly string[];
}

/** A plugin that wraps a remote MCP server. */
export interface McpIntegrationPlugin {
  kind: "mcp";
  manifest: McpIntegrationManifest;
}

/** Any plugin a module may export. */
export type GuildPlugin = IntegrationPlugin | McpIntegrationPlugin;

/** Declares a plugin that wraps a remote MCP server. */
export function mcpIntegration(manifest: McpIntegrationManifest): McpIntegrationPlugin {
  return { kind: "mcp", manifest };
}

export function isMcpPlugin(plugin: GuildPlugin): plugin is McpIntegrationPlugin {
  return (plugin as McpIntegrationPlugin).kind === "mcp";
}
