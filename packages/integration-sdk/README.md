# @guild/integration-sdk

The contract between Guild and an integration plugin, the request helpers
every integration builds on, and the `guild-plugin` CLI that packs,
publishes and catalogs plugin bundles. The server's built-in integrations
use the same package.

## A plugin

A plugin repository holds one module whose default export is an
`IntegrationPlugin`:

```ts
import { probe, fetchTimeout, PROBE_TIMEOUT_MS, secret, type IntegrationPlugin } from "@guild/integration-sdk";

const plugin: IntegrationPlugin = {
  manifest: {
    name: "acme",                 // the slug: [a-z0-9_-], not a built-in's
    title: "Acme",
    version: "1.0.0",             // bump for every release
    publisher: "Acme Inc.",
    summary: "One line for the shop card",
    description: "Markdown for the shop detail page",
    docs_url: null,
    categories: ["search"],
    traits: { web_search: "search" },   // trait -> the tool implementing it
    auth_kind: "org_secret",
    identity_key: "email",
    fields: [
      { name: "base_url", kind: "string", label: "API URL", required: true, default: null, help: null, placeholder: null },
      { name: "token", kind: "secret", label: "API token", required: true, default: null, help: null, placeholder: null },
    ],
    tools: [
      { name: "search", class: "read", description: "Search Acme", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } },
    ],
  },
  async testConnection(config, secrets) {
    await probe(fetch(`${config.base_url}/me`, fetchTimeout(PROBE_TIMEOUT_MS, { headers: { authorization: `Bearer ${secret(secrets, "token")}` } })), "acme");
  },
  async execute(config, tool, args, secrets, actingAs) {
    // return { content } — a failure the model should read is a thrown Error
    return { content: "…" };
  },
};

export default plugin;
```

- **Settings** are the `fields`; `secret`-kind fields are stored encrypted
  and reach `testConnection`/`execute` as `secrets` pairs, never in config.
- **Tool classes** (`read`, `write`, `admin`) are the policy floor: members
  get `read` tools by default.
- **Traits** (`web_search`, `web_fetch`) give a tool Guild's shared name,
  description and argument schema; the org picks one provider per trait.
- The plugin runs in a worker thread of the Guild server. It has network
  and filesystem access, so admins approve each exact bundle.

## Build and ship

```
guild-plugin pack src/integration.ts --out dist
guild-plugin publish dist/acme-1.0.0.guildplugin --server https://guild.example.com --token $GUILD_TOKEN --approve
guild-plugin catalog add dist/acme-1.0.0.guildplugin --index catalog/index.json --name "Acme plugins"
```

`pack` needs Bun. `publish` uploads to one server's registry (`--approve`
with an admin token also approves and installs it). `catalog add` lists the
version in a catalog index; host the index and its `bundles/` folder in a
public repository (served as a URL) or a private GitHub/GitLab repository
(each org reads it with its own GitHub/GitLab integration).

## Catalog format

```json
{
  "format": "guild-plugin-catalog/1",
  "name": "Acme plugins",
  "plugins": [
    {
      "slug": "acme", "title": "Acme", "summary": "…", "publisher": "Acme Inc.",
      "categories": ["search"], "traits": ["web_search"], "docs_url": null,
      "versions": [
        { "version": "1.0.0", "sha256": "<hex>", "bundle": "bundles/acme-1.0.0.guildplugin", "published_at": "…" }
      ]
    }
  ]
}
```

Versions are newest first. `bundle` is a path relative to the index or an
absolute URL; the server refuses bytes that do not match `sha256`.
