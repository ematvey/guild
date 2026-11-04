# Guild catalog

Integrations any Guild org can install from Settings → Integrations →
Catalogs. An org adds this catalog as a GitHub source: repository
`maintainer/guild`, ref `develop`, path `catalog/index.json`. Its GitHub
integration token reads it.

Each folder under `plugins/` is one entry. A folder with `manifest.json`
and no code is an MCP stub: it names a remote MCP server, the settings an
admin fills in, and the headers they become. Its tools are discovered live
once the integration is configured. `packages/integration-sdk/README.md`
(§ MCP stubs) has the manifest shape.

## Add or update an entry

Bump `version` in the manifest for every change: a server refuses
different bytes under a version it already holds.

    bun packages/integration-sdk/bin/guild-plugin.ts pack catalog/plugins/<slug> --out /tmp/guild-catalog
    bun packages/integration-sdk/bin/guild-plugin.ts catalog add /tmp/guild-catalog/<slug>-<version>.guildplugin --index catalog/index.json

Commit `index.json`, the bundle under `bundles/` and the plugin folder
together.
