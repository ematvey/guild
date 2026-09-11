# Integration plugin system — design

Date: 2026-09-12. Status: approved in design dialogue with maintainer; this
spec is the contract for milestone 9. Builds on the guild design doc
(§4.4 registry, §4.6 integrations) and the existing code: compiled-in
`Integration` trait plugins (searxng, superproxy), Restate routines,
registry bundles, org API keys.

## 1. Problem

The current integration plugin surface is compile-time only: adding an
integration means implementing a Rust trait and recompiling the server.
The goal is an extendable, plugin-based system where integrations are
added by us **and** by third parties without recompiling Guild, executed
and controlled server-side, callable from the chat loop and from scripts
(server-side sandboxes and user machines), with per-connector access
control that Guild owns — because integrations connect **org-wide**
(admin configures once, everyone gets the tools), not per user like
standard MCP.

## 2. Decisions made in design dialogue

- The plugin contract is a **server-side MCP server** (streamable HTTP),
  not sandbox CLIs. CLIs inside the plugin system are an antipattern:
  a manifest that bakes binaries into sandbox images is a supply-chain
  hole. Vendor CLIs may exist *inside* an integration's MCP server as
  its implementation detail; they are not part of the contract.
- Scriptability comes from a **tool HTTP API**, not a local CLI: the
  same tool calls the chat loop makes are reachable over HTTPS, so a
  script (curl, any language, user's own CLI) can loop, pipe, and join
  across integrations while every operation stays a controlled, audited
  server call.
- Org-wide connection ≠ org identity: the **connection** (secret) is
  org-wide; the **identity** a call acts as is resolved per call
  (internal project's Google model: one domain-wide service account, every call
  carries a `sub` claim). Guild owns identity mapping, impersonation
  policy, and tool-level access control.
- Progressive disclosure is enforced by the same policy filter that
  guards execution: a member never sees tools they cannot call.
- Compiled-in Rust `Integration` plugins remain for tiny built-ins
  (searxng, superproxy) that do not justify a separate process.
- Personal extensions (own MCP servers in `.guild/mcp.json`, own
  skills) stay client-side and are out of scope of the org plugin
  system.

## 3. The plugin contract

A plugin is a registry bundle, kind `integration`, whose manifest
(`manifest.json` at the tar.gz root) declares:

```json
{
  "kind": "integration",
  "slug": "hubspot",
  "version": "1.2.0",
  "description": "HubSpot CRM tools",
  "mcp": { "url": "https://hubspot-mcp.example.com/mcp" },
  "auth": {
    "kind": "org_secret",
    "secret_names": ["api_key"],
    "identity_key": "email"
  },
  "tools": {
    "classes": { "search_contacts": "read", "update_deal": "write" }
  },
  "triggers": [
    { "kind": "webhook", "prompt": "digest it", "model": "gpt-4o-mini" }
  ],
  "skills": ["hubspot-cookbook"]
}
```

All fields except kind/slug/version/description are optional with
serde defaults, so existing v1 bundles (routine.json automations) keep
publishing and installing unchanged.

- `mcp.url` — absolute streamable-HTTP MCP endpoint. If absent, the
  bundle is a v1 automation bundle (routine.json only).
- `auth.kind` — one of:
  - `org_secret` — one org-wide secret (Stripe key, HubSpot PAT).
  - `org_secret_impersonated` — org-wide credential, per-call acting
    identity (Google service account with domain-wide delegation).
  - `per_user_token` — OAuth token per org member, cached by Guild.
  Default: `org_secret`.
- `auth.identity_key` — how Guild maps an org member to an external
  identity; `email` (the only supported value in v1: the guild
  member's email is the join key).
- `tools.classes` — per-tool class: `read` (default), `write`,
  `admin`. Unknown tool names from the server at runtime are treated
  as `read` unless a prefix rule matches (see §6).
- `triggers` — v1-compatible trigger descriptors (same shape as
  routine.json entries); install creates disabled routines.
- `skills` — slugs of cookbook skill bundles (SKILL.md) published to
  the same registry; surfaced as on-demand guides (§7).

## 4. Connection and secrets

New table `integration_secrets` (migration `0029_integration_secrets.sql`):

```sql
CREATE TABLE integration_secrets (
    org_id UUID NOT NULL,
    integration TEXT NOT NULL,
    name TEXT NOT NULL,
    secret_enc TEXT NOT NULL,          -- hex(nonce||ct), AES-256-GCM
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, integration, name)
);
```

- Encrypted with the existing master key (`crypto.rs`,
  `encrypt_secret`/`decrypt_secret`).
- Admin API: `PUT /api/v1/admin/integrations/{name}/secrets`
  `{name, value}` (upsert), `DELETE
  /api/v1/admin/integrations/{name}/secrets/{secret}` (remove),
  `GET /api/v1/admin/integrations/{name}/secrets` → names + updated_at
  only, never values.
- The worker resolves a connection as: decrypt secrets for (org,
  integration) → pass to the MCP server as headers on connect and
  call: `x-guild-secret-<name>: <value>`. Secrets never appear in
  chat logs, tool results, or API responses.

## 5. Identity envelope and impersonation

Every tool call carries an identity envelope, delivered as HTTP
headers to the integration's MCP server:

```
x-guild-org: <org uuid>
x-guild-caller: <guild user id>
x-guild-acting-as: <resolved external identity, e.g. email>
x-guild-call-id: <call uuid>
```

- `acting_as` resolution: `caller`'s guild email (join per
  `auth.identity_key = email`). For org API keys (no user), `acting_as`
  is null unless the request declares one.
- **Impersonation policy**: a caller may set `acting_as` to another
  member's identity only if the caller is an org admin. Non-admin
  overrides are rejected 403. A null `acting_as` (unmapped or
  undeclared) is passed through as null; the connector decides its own
  default identity (the internal project `admin_user` pattern).
- `per_user_token` connections: Guild caches one token per
  (org, integration, member) in the secrets table with
  `name = "user:<guild user id>"`; v1 ships the storage and envelope
  wiring, token acquisition UI is out of scope.

## 6. Access control

- Org integration config (the existing `integrations` table,
  `config` JSON) gains for MCP plugins:
  `{ "mcp": {"url": "..."}, "tool_policy": {"member": ["read"],
  "admin": ["read","write","admin"]} }`. The admin API validates
  `mcp.url` is an absolute http(s) URL when present.
- Enforcement happens in the worker / tool API **before** the call
  reaches the connector: resolve caller's org role → allowed classes →
  reject 403 outside them. Org owner counts as admin.
- Default policy when unset: `member: ["read"], admin:
  ["read","write","admin"]`.
- Manifest `tools.classes` is the connector's declaration; it wins at
  runtime: a tool declared `admin` is callable only by admins even if
  org policy would allow writes. The effective class is
  `max(manifest class, org policy grant)` — an org can tighten, not
  loosen, the manifest.

## 7. Progressive disclosure

Chat loop (worker), three levels:

1. **Turn start index** — system prompt gains one line per enabled
   integration: `Integration hubspot: HubSpot CRM tools — call
   int_hubspot_list_tools to discover its tools.` No tool schemas are
   preloaded.
2. **On-demand tool list** — Guild auto-provides, per enabled
   integration, a tool `int_<slug>_list_tools` (class `read`): returns
   the policy-filtered tool list with names, descriptions, and JSON
   schemas. Tool list is journaled at turn start so Restate replay is
   deterministic.
3. **On-demand guide** — Guild auto-provides `int_<slug>_guide` (class
   `read`): returns the cookbook SKILL.md body of the first slug in
   `skills` (or the bundle README), fetched from object storage. Only
   the pointer appears in the index.

MCP server tools are exposed namespaced: `int_<slug>_<tool>`. Names
longer than 64 chars are rejected at install time (provider name
limits).

Script API (`http/integration_tools.rs`) mirrors the same filtering:

- `GET /api/v1/integrations` → `{items: [{slug, description, tools: N}]}`
  for the caller's org, enabled only, policy-filtered (count only).
- `GET /api/v1/integrations/{slug}/tools` → full policy-filtered list
  with schemas.
- `POST /api/v1/integrations/{slug}/tools/{tool}` → execute one tool.
  Body is the JSON arguments object. Auth: member session or org API
  key (same auth as the OpenAI-compatible endpoint). Returns
  `{ok: true, content, meta}` or `{ok: false, error}`.

## 8. Execution

- The worker resolves enabled integrations at turn start (journaled).
  For MCP plugins it connects (rmcp streamable HTTP, connection cached
  in AppState outside the journal — reconnect on replay is safe) and
  journals the tool list snapshot.
- Execution of one MCP tool call is journaled like existing server
  tools: notify clients → call (via the cached connection, with the
  identity envelope + secret headers) → persist tool_result event with
  content and meta.
- **Audit**: every MCP tool call appends an org event
  `integration.tool_called` `{slug, tool, caller, acting_as, ok,
  via: "chat"|"script"}` (chat-loop calls already persist the full
  tool_result in the thread log; the org event adds the identity
  record).
- A broken MCP server degrades like a broken local MCP server: the
  plugin contributes nothing this turn (warning logged), the turn
  continues with remaining tools.

## 9. Admin and registry flow

- **Registry publish** (exists): kind `integration` bundles publish
  unchanged; the API now also validates manifest v2 fields when
  present (mcp.url absolute http(s), auth.kind in the allowed set,
  tool classes in {read,write,admin}, namespaced tool names ≤ 64
  chars, triggers valid).
- **Registry install** (updated): for a v2 manifest with `mcp.url`,
  install creates a **disabled** row in `integrations` with config
  `{mcp, auth, tool_policy defaults}` (skipped if a row already
  exists), plus disabled routines from `triggers`/routine.json
  (existing behavior). Secrets are set afterward by an admin via the
  secrets API; enabling is blocked until every `secret_names` entry
  has a stored secret.
- **Admin API** (updated):
  - `GET /admin/integrations` — rows plus `available` now includes
    installed-but-unconfigured v2 plugins (from the registry) alongside
    the compiled-in kinds.
  - `PUT /admin/integrations/{name}` — as today; for v2 rows the body
    may carry `tool_policy`; `enabled: true` requires the MCP url and
    all declared secrets present.
  - `DELETE /admin/integrations/{name}` — as today (also drops
    secrets).

## 10. Out of scope (explicit)

- OAuth consent flows for `per_user_token` (storage + envelope only).
- Webhook ingress for connector-specific event payloads beyond the
  existing hook endpoint.
- Desktop/webui settings UI for secrets and tool policies (the API
  ships first; UI is a follow-up. Existing screens keep working — the
  integrations API remains backward compatible).
- Renaming/re-signing existing bundle kinds; skill and mcp registry
  kinds unchanged.

## 11. Verification

- `cargo test --workspace` green (new tests: manifest v2 validation
  round-trips; secrets store + encryption; registry install for v2
  bundles; tool API authz matrix incl. impersonation rules and class
  enforcement; fixture MCP server over HTTP driven through the worker
  resolution path; disclosure filtering).
- `cargo clippy --workspace -- -D warnings` clean.
- Existing integration tests (registry install v1, admin integrations
  CRUD) unchanged and green.
