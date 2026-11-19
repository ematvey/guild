// The registry manifest.json of a plugin bundle, derived from the plugin's
// own manifest: the storefront and policy fields a Guild server validates
// and lists without running any code. `guild-plugin pack` writes it; the
// server checks a code plugin's plugin.js against it when it loads the
// bundle, and serves a built-in MCP plugin through the same shape.

import type { IntegrationManifest, McpIntegrationManifest } from "./types.js";

/** The registry manifest.json of a code plugin: the storefront and policy
 *  fields the server validates and lists without running the code. */
export function registryManifest(m: IntegrationManifest): Record<string, unknown> {
  return {
    kind: "integration",
    slug: m.name,
    version: m.version,
    runtime: "code",
    title: m.title,
    summary: m.summary,
    description: m.summary,
    publisher: m.publisher,
    docs_url: m.docs_url,
    categories: m.categories,
    traits: m.traits,
    auth: {
      kind: m.auth_kind,
      secret_names: m.fields.filter((f) => f.kind === "secret").map((f) => f.name),
      identity_key: m.identity_key,
    },
    settings: { fields: m.fields },
    tools: {
      classes: Object.fromEntries(m.tools.map((t) => [t.name, t.class])),
      declared: m.tools.map((t) => ({ name: t.name, class: t.class, description: t.description })),
    },
    ...(m.skills === undefined ? {} : { skills: [...m.skills] }),
  };
}

/** The registry manifest.json of an MCP plugin: its server, settings and
 *  any declared tool classes. It lists no tools; they are discovered live. */
export function mcpRegistryManifest(m: McpIntegrationManifest): Record<string, unknown> {
  return {
    kind: "integration",
    slug: m.name,
    version: m.version,
    title: m.title,
    summary: m.summary,
    description: m.description,
    publisher: m.publisher,
    docs_url: m.docs_url,
    categories: m.categories,
    mcp: { url: m.mcp.url, headers: m.mcp.headers ?? {}, envelope: m.mcp.envelope !== false },
    auth: {
      kind: "org_secret",
      secret_names: m.fields.filter((f) => f.kind === "secret").map((f) => f.name),
      identity_key: "email",
    },
    settings: { fields: m.fields },
    tools: { classes: { ...(m.tool_classes ?? {}) } },
    ...(m.skills === undefined ? {} : { skills: [...m.skills] }),
  };
}
