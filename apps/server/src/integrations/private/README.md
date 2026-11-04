# Private integrations

This folder holds integration plugins that belong to one organization and do
not ship with Guild. Everything here except this README is gitignored: keep
the plugins in their own repository and clone it to this path:

    git clone <your-integrations-repo> apps/server/src/integrations/private

## Loading

At startup the server imports every `private/<folder>/integration.ts` and
reads its default export as an `IntegrationPlugin`. Private plugins are
listed before the built-ins, so a private plugin that provides a trait
(`web_fetch`, `web_search`) wins it over a built-in provider. A private
plugin may not reuse a built-in slug: the server refuses to start.

The compose image copies `apps/server/src` whole, so a checkout here ships
with the next rebuild. A checkout without this folder runs the built-ins
only, and integration rows of a missing plugin are skipped.

## Writing a plugin

A plugin is one folder, the same shape as the built-ins next door
(`../searxng/` is the smallest example):

- `integration.ts` — default export: `manifest` (slug, storefront text,
  settings fields, tools with their class, traits), `validate`,
  `testConnection`, `execute`.
- `execute.ts` — the tool calls.
- `logo.svg` — optional; the shop falls back to a monogram.
- `*.test.ts` — run by the server's vitest suite like any other test.

Import server code only from `../../sdk.js`. It carries the plugin types and
the request helpers (timeouts, capped bodies, secret lookup, the public
fetch-target guard, the connection probe). Anything else in the server can
move without notice.
