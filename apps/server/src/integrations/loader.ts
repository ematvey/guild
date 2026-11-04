// The plugin loader: turns plugins into the connectors the admin API, the
// turn resolver, and the dispatcher read. Two kinds of plugin reach it: the
// built-ins compiled into the server (the plugin index), and code plugins an
// org installed from its registry (code-plugins.ts loads those per org).
// Every manifest is validated here — a malformed built-in fails at startup,
// a malformed code plugin fails its load and is skipped.

import { readFileSync } from "node:fs";
import { traitSpec } from "@guild/integration-sdk";
import { PLUGINS } from "./index.js";
import type { JsonObject, ToolOutcome } from "./shared.js";
import type {
  IntegrationField,
  IntegrationManifest,
  IntegrationPlugin,
  IntegrationToolDecl,
} from "@guild/integration-sdk";

export type { IntegrationField, IntegrationManifest, IntegrationPlugin, IntegrationToolDecl };
export type IntegrationTraits = Record<string, string>;

export interface IntegrationToolSpec {
  name: string;
  description: string;
  /** JSON Schema object. */
  parameters: unknown;
}

/** Where a connector's code comes from: compiled into the server, or an
 *  approved registry bundle of the org. */
export type ConnectorOrigin = "builtin" | "registry";

/** A loaded plugin: its manifest plus the derived shapes the server uses. */
export interface Connector extends IntegrationManifest {
  origin: ConnectorOrigin;
  /** Credential field names, derived from the secret-kind settings fields. */
  secret_names: string[];
  /** Tool name to policy class (the manifest's declaration). */
  classes: Record<string, string>;
  /** The shop logo as SVG markup. */
  logo: string;
  /** The plugin's README.md: the landing page people read. Empty when the
   *  plugin ships none. */
  readme: string;
  /** Validates the row config (throws on a broken one) and declares the
   *  tool surface the integration contributes. */
  toolSpecs(config: JsonObject): Promise<IntegrationToolSpec[]>;
  testConnection(config: JsonObject, secrets: [string, string][]): Promise<void>;
  execute(
    config: JsonObject,
    tool: string,
    args: JsonObject,
    secrets: [string, string][],
    actingAs: string | null,
  ): Promise<ToolOutcome>;
}

const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const FIELD_NAME = /^[a-z0-9_]{1,64}$/;
const FIELD_KINDS = new Set(["string", "text", "number", "boolean", "secret"]);
const TOOL_CLASSES = new Set(["read", "write", "admin"]);
const AUTH_KINDS = new Set(["org_secret", "org_secret_impersonated", "per_user_token"]);
const IDENTITY_KEYS = new Set(["email", ""]);

function fail(slug: string, message: string): never {
  throw new Error(`integration ${slug}: ${message}`);
}

/** Checks one plugin manifest; throws `integration <slug>: <reason>`. */
export function validatePluginManifest(m: IntegrationManifest): void {
  if (m === null || typeof m !== "object") throw new Error("plugin manifest is not an object");
  if (typeof m.name !== "string" || !SLUG.test(m.name))
    fail(String(m.name), "slug must be [a-z0-9_-], at most 64 chars");
  for (const key of ["title", "summary", "version", "publisher", "description"] as const) {
    if (typeof m[key] !== "string") fail(m.name, `${key} must be a string`);
  }
  if (m.title.trim() === "") fail(m.name, "title is empty");
  if (m.summary.trim() === "") fail(m.name, "summary is empty");
  if (m.version.trim() === "") fail(m.name, "version is empty");
  if (!Array.isArray(m.categories) || !Array.isArray(m.fields) || !Array.isArray(m.tools)) {
    fail(m.name, "categories, fields and tools must be arrays");
  }
  if (m.traits === null || typeof m.traits !== "object") fail(m.name, "traits must be an object");
  if (!AUTH_KINDS.has(m.auth_kind)) fail(m.name, `unknown auth_kind ${m.auth_kind}`);
  if (!IDENTITY_KEYS.has(m.identity_key)) fail(m.name, `unsupported identity_key ${m.identity_key}`);
  const fields = new Set<string>();
  for (const f of m.fields) {
    if (!FIELD_NAME.test(f.name)) fail(m.name, `settings field ${f.name} must be [a-z0-9_]`);
    if (!FIELD_KINDS.has(f.kind)) fail(m.name, `settings field ${f.name} has unknown kind ${f.kind}`);
    if (fields.has(f.name)) fail(m.name, `duplicate settings field ${f.name}`);
    fields.add(f.name);
  }
  const tools = new Set<string>();
  for (const t of m.tools) {
    if (typeof t.name !== "string" || t.name === "" || tools.has(t.name)) {
      fail(m.name, `duplicate or empty tool name ${t.name}`);
    }
    if (!TOOL_CLASSES.has(t.class)) fail(m.name, `tool ${t.name} has unknown class ${t.class}`);
    tools.add(t.name);
  }
  for (const [trait, tool] of Object.entries(m.traits)) {
    if (traitSpec(trait) === undefined) fail(m.name, `unknown trait ${trait}`);
    if (!tools.has(tool)) fail(m.name, `trait ${trait} names undeclared tool ${tool}`);
  }
}

/** The connector over a validated manifest and the plugin's functions. */
export function connectorOf(
  m: IntegrationManifest,
  origin: ConnectorOrigin,
  files: { logo: string; readme: string },
  fns: {
    validate(config: JsonObject): Promise<void> | void;
    testConnection: Connector["testConnection"];
    execute: Connector["execute"];
  },
): Connector {
  validatePluginManifest(m);
  return {
    ...m,
    origin,
    secret_names: m.fields.filter((f) => f.kind === "secret").map((f) => f.name),
    classes: Object.fromEntries(m.tools.map((t) => [t.name, t.class])),
    logo: files.logo,
    readme: files.readme,
    async toolSpecs(config: JsonObject): Promise<IntegrationToolSpec[]> {
      await fns.validate(config);
      return m.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    },
    testConnection: fns.testConnection,
    execute: fns.execute,
  };
}

/** One file of the plugin folder as text: logo.svg (a plugin without one
 *  gets the shop's monogram fallback) or README.md. Missing reads as "". */
function fileIn(dir: URL, name: string): string {
  try {
    return readFileSync(new URL(name, dir), "utf8");
  } catch {
    return "";
  }
}

function builtin(plugin: IntegrationPlugin): Connector {
  const dir = new URL(`./${plugin.manifest.name}/`, import.meta.url);
  return connectorOf(plugin.manifest, "builtin", { logo: fileIn(dir, "logo.svg"), readme: fileIn(dir, "README.md") }, {
    validate: (config) => plugin.validate?.(config),
    testConnection: (config, secrets) => plugin.testConnection(config, secrets),
    execute: (config, tool, args, secrets, actingAs) => plugin.execute(config, tool, args, secrets, actingAs),
  });
}

/** The built-in integrations, in priority order (the shop and the default
 *  trait provider order both read it). */
export function loadBuiltins(plugins: IntegrationPlugin[]): Connector[] {
  const seen = new Set<string>();
  for (const plugin of plugins) {
    if (seen.has(plugin.manifest.name)) fail(plugin.manifest.name, "two plugins declare this slug");
    seen.add(plugin.manifest.name);
  }
  return plugins.map(builtin);
}

export const BUILTINS: Connector[] = loadBuiltins(PLUGINS);

export function builtinByName(name: string): Connector | undefined {
  return BUILTINS.find((c) => c.name === name);
}
