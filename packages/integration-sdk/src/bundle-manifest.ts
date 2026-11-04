// The registry manifest.json of a code plugin bundle, derived from the
// plugin's own manifest: the storefront and policy fields a Guild server
// validates and lists without running the code. `guild-plugin pack` writes
// it; the server checks plugin.js against it when it loads the bundle.

import type { IntegrationManifest } from "./types.js";

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
    tools: { classes: Object.fromEntries(m.tools.map((t) => [t.name, t.class])) },
  };
}
