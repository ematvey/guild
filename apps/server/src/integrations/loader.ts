// The plugin loader: turns the folder-per-integration plugins into the
// catalog the admin API, the turn resolver, and the dispatcher read. Every
// plugin is validated here once — a malformed manifest fails at startup, not
// in a chat.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { PLUGINS } from "./index.js";
import { traitSpec } from "./traits.js";
import type { JsonObject, ToolOutcome } from "./shared.js";
import type { IntegrationField, IntegrationManifest, IntegrationPlugin, IntegrationToolDecl } from "./types.js";

export type { IntegrationField, IntegrationManifest, IntegrationPlugin, IntegrationToolDecl };
export type IntegrationTraits = Record<string, string>;

export interface IntegrationToolSpec {
  name: string;
  description: string;
  /** JSON Schema object. */
  parameters: unknown;
}

/** A loaded plugin: its manifest plus the derived shapes the server uses. */
export interface BuiltinIntegration extends IntegrationManifest {
  /** Credential field names, derived from the secret-kind settings fields. */
  secret_names: string[];
  /** Tool name to policy class (the manifest's declaration). */
  classes: Record<string, string>;
  /** The shop logo as SVG markup. */
  logo: string;
  /** Validates the row config (throws on a broken one) and declares the
   *  tool surface the integration contributes. */
  toolSpecs(config: JsonObject): IntegrationToolSpec[];
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

function validateManifest(m: IntegrationManifest): void {
  if (!SLUG.test(m.name)) fail(m.name, "slug must be [a-z0-9_-], at most 64 chars");
  if (m.title.trim() === "") fail(m.name, "title is empty");
  if (m.summary.trim() === "") fail(m.name, "summary is empty");
  if (m.version.trim() === "") fail(m.name, "version is empty");
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
    if (t.name === "" || tools.has(t.name)) fail(m.name, `duplicate or empty tool name ${t.name}`);
    if (!TOOL_CLASSES.has(t.class)) fail(m.name, `tool ${t.name} has unknown class ${t.class}`);
    tools.add(t.name);
  }
  for (const [trait, tool] of Object.entries(m.traits)) {
    if (traitSpec(trait) === undefined) fail(m.name, `unknown trait ${trait}`);
    if (!tools.has(tool)) fail(m.name, `trait ${trait} names undeclared tool ${tool}`);
  }
}

function secretNames(m: IntegrationManifest): string[] {
  return m.fields.filter((f) => f.kind === "secret").map((f) => f.name);
}

/** The plugin folder's logo.svg. A plugin without one gets an empty string
 *  and the shop renders its monogram fallback. */
function logoIn(dir: URL): string {
  try {
    return readFileSync(new URL("logo.svg", dir), "utf8");
  } catch {
    return "";
  }
}

/** One plugin and the folder it was loaded from (its logo sits there). */
export interface PluginSource {
  plugin: IntegrationPlugin;
  dir: URL;
}

/** The organization's own plugins: every `private/<folder>/integration.ts`
 *  default export, in folder-name order. The folder is gitignored, so a
 *  checkout without it serves the built-ins only. */
async function privatePlugins(root: URL): Promise<PluginSource[]> {
  if (!existsSync(root)) return [];
  const folders = readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && d.name !== "node_modules")
    .map((d) => d.name)
    .sort();
  const out: PluginSource[] = [];
  for (const folder of folders) {
    const dir = new URL(`${folder}/`, root);
    const entry = new URL("integration.ts", dir);
    if (!existsSync(entry)) continue;
    const mod = (await import(entry.href)) as { default?: IntegrationPlugin };
    if (mod.default === undefined || typeof mod.default !== "object" || mod.default.manifest === undefined) {
      throw new Error(`private integration ${folder}: integration.ts has no default plugin export`);
    }
    out.push({ plugin: mod.default, dir });
  }
  return out;
}

function load({ plugin, dir }: PluginSource): BuiltinIntegration {
  const m = plugin.manifest;
  validateManifest(m);
  const classes = Object.fromEntries(m.tools.map((t) => [t.name, t.class]));
  return {
    ...m,
    secret_names: secretNames(m),
    classes,
    logo: logoIn(dir),
    toolSpecs(config: JsonObject): IntegrationToolSpec[] {
      plugin.validate?.(config);
      return m.tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
    },
    testConnection: (config, secrets) => plugin.testConnection(config, secrets),
    execute: (config, tool, args, secrets, actingAs) => plugin.execute(config, tool, args, secrets, actingAs),
  };
}

/** Every integration, in priority order: the organization's private plugins
 *  first, then the built-ins of the plugin index (the shop and the trait
 *  provider priority both read this order). A private plugin may not reuse
 *  a built-in slug. */
export function loadIntegrations(sources: PluginSource[]): BuiltinIntegration[] {
  const seen = new Set<string>();
  for (const { plugin } of sources) {
    if (seen.has(plugin.manifest.name)) fail(plugin.manifest.name, "two plugins declare this slug");
    seen.add(plugin.manifest.name);
  }
  return sources.map(load);
}

const PRIVATE_ROOT = new URL("./private/", import.meta.url);

export const INTEGRATIONS: BuiltinIntegration[] = loadIntegrations([
  ...(await privatePlugins(PRIVATE_ROOT)),
  ...PLUGINS.map((plugin) => ({ plugin, dir: new URL(`./${plugin.manifest.name}/`, import.meta.url) })),
]);

export function integrationByName(name: string): BuiltinIntegration | undefined {
  return INTEGRATIONS.find((c) => c.name === name);
}

/** The trait one of an integration's tools implements, when it implements
 *  one. */
export function traitForTool(name: string, raw: string): string | undefined {
  const integration = integrationByName(name);
  if (integration === undefined) return undefined;
  for (const [trait, tool] of Object.entries(integration.traits)) {
    if (tool === raw) return trait;
  }
  return undefined;
}

/** Trait provider priority: the first enabled integration declaring the
 *  trait wins it; the rest keep their other tools and drop the trait one. */
export function traitProviders(): { trait: string; slug: string; tool: string }[] {
  const out: { trait: string; slug: string; tool: string }[] = [];
  for (const integration of INTEGRATIONS) {
    for (const [trait, tool] of Object.entries(integration.traits)) {
      out.push({ trait, slug: integration.name, tool });
    }
  }
  return out;
}
