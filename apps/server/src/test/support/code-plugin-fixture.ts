// A code plugin bundle built in memory: a plain-JS plugin.js (what
// `guild-plugin pack` emits, minus the bundled SDK) plus the derived
// registry manifest. Tests vary the slug, version and the module body.

import { createHash } from "node:crypto";
import { registryManifest, type IntegrationManifest } from "@guild/integration-sdk";
import { packBundle } from "../../platform/bundle.js";

export function fixtureManifest(slug: string, version: string): IntegrationManifest {
  return {
    name: slug,
    title: `Acme ${slug}`,
    version,
    publisher: "Acme",
    summary: "Acme test plugin",
    description: "A plugin the tests build in memory.",
    docs_url: null,
    categories: ["test"],
    traits: { web_search: "search" },
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      {
        name: "greeting",
        kind: "string",
        label: "Greeting",
        required: false,
        default: "hi",
        help: null,
        placeholder: null,
      },
      {
        name: "token",
        kind: "secret",
        label: "Token",
        required: true,
        default: null,
        help: null,
        placeholder: null,
        obtain: "Create one under **Settings → Tokens**.",
      },
    ],
    tools: [
      { name: "echo", class: "read", description: "Echo the text", parameters: { type: "object" } },
      { name: "search", class: "read", description: "Search", parameters: { type: "object" } },
      { name: "hang", class: "write", description: "Never returns", parameters: { type: "object" } },
      { name: "crash", class: "write", description: "Kills the worker", parameters: { type: "object" } },
    ],
  };
}

/** The plugin module source: echo/search answer, hang never returns, crash
 *  exits the worker; testConnection wants the secret `token` = "good". */
export function fixtureSource(manifest: IntegrationManifest): string {
  return `
const manifest = ${JSON.stringify(manifest)};
export default {
  manifest,
  validate(config) {
    if (config.greeting === "invalid") throw new Error("greeting is invalid");
  },
  async testConnection(config, secrets) {
    const token = secrets.find(([n]) => n === "token")?.[1];
    if (token !== "good") throw new Error("acme rejected the token");
  },
  async execute(config, tool, args, secrets, actingAs) {
    if (tool === "echo") return { content: (config.greeting ?? "hi") + ":" + args.text + ":" + (actingAs ?? "") };
    if (tool === "search") return { content: "results for " + args.query };
    if (tool === "hang") return new Promise(() => {});
    if (tool === "crash") process.exit(3);
    throw new Error("unknown tool " + tool);
  },
};
`;
}

export function fixtureBundle(
  slug: string,
  version: string,
  opts: { source?: string; manifest?: IntegrationManifest; readme?: string } = {},
): { bytes: Buffer; sha256: string } {
  const manifest = opts.manifest ?? fixtureManifest(slug, version);
  const bytes = packBundle({
    "manifest.json": JSON.stringify(registryManifest(manifest)),
    "plugin.js": opts.source ?? fixtureSource(manifest),
    "logo.svg": "<svg/>",
    ...(opts.readme !== undefined ? { "README.md": opts.readme } : {}),
  });
  return { bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
