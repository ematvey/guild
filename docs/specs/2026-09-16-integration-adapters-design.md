# Integration adapters — uniform internal interface, MCP as a wrapped special case

Date: 2026-09-16
Status: approved design (in discussion), pending implementation plan
Supersedes parts of: `2026-09-12-integration-plugins-design.md` (§ executor
model), `2026-09-12-milestone-10-unified-plugins.md` (in-code manifests)

## Problem

Integrations are data + code, but the two halves are fused differently for
the two kinds:

- **Built-in connectors** (slack, github, gitlab, atlassian, google_workspace,
  hubspot, langfuse) declare tools as Rust code (`Integration::tools()` bodies)
  and manifest class pairs passed to `in_code_manifest()` — two hand-maintained
  parallel lists — and their execution code is inseparable from the binary.
- **Registry MCP plugins** declare data in a downloadable bundle and execute
  via the MCP protocol.

Consequences: tool declarations live in code (the admin UI cannot show what an
integration declares without resolving a turn); built-ins cannot be
distributed the way bundles are (downloadable, locally seeded, per-org
installable); MCP is a parallel resolution path rather than a special case of
one interface.

## Goal

1. One internal interface that every integration speaks. MCP is not a peer
   interface — it is wrapped by an adapter of that interface.
2. Tool declarations are data, shipped in bundles. Built-ins become embedded
   bundles: same format as downloadable registry bundles, same install path,
   pre-seeded locally.
3. The admin integrations UI can show, per integration, the full declared tool
   list (the feature this grew out of).

Non-goals: wasm executors (future adapter kind, same trait); converting
built-ins to MCP servers; changing the wire namespacing (`int_<slug>_<tool>`),
policy filter, secrets store, identity envelope, or journaling shapes.

## Naming

The code-behind-the-interface trait is **`ToolAdapter`** (adapter pattern:
adapts an external execution surface — vendor REST API, MCP server, later wasm
— to the internal tool interface). Rejected: `Executor` (collides with Guild's
machine-bound chat tool executor: `executor_acquire`, `EXECUTOR_TTL_SECS`),
`ToolProvider` (collides with model providers; wrongly suggests it owns the
tool list), `ToolSet` (a set holds tools — this deliberately no longer does),
`ToolDriver` (user rejected), `ToolBackend` (already a vague word in the repo).

## 1. The contract: `ToolAdapter`

Code only. No tool declarations, no manifest on the trait.

```rust
#[async_trait]
pub trait ToolAdapter: Send + Sync {
    fn name(&self) -> &str;                        // "slack", "mcp", …
    /// Runs one tool. Everything execute() receives today rides in ctx:
    /// resolved secrets, acting-as identity, org/user ids, call_id, config.
    async fn run_tool(&self, call: ToolCall<'_>, ctx: ExecCtx<'_>)
        -> Result<ToolOutcome, String>;
    /// Config validation (today's tools()-side validation, minus tool
    /// declaration). An error means the admin supplied a broken config.
    fn validate_config(&self, config: &serde_json::Value) -> Result<()>;
    /// One cheap authenticated round-trip (today's `test_connection`,
    /// unchanged semantics: a save is persisted only when this succeeds).
    async fn test_connection(&self, config: &Value, secrets: &[(String, String)])
        -> Result<(), String>;
}
```

- The seven connectors keep their `execute` / validation / probe code as
  `SlackToolAdapter`, `GithubToolAdapter`, … — registered in a static adapter
  table keyed `(name, api_version)`.
- **`McpToolAdapter`** is the MCP special case: `run_tool` proxies into the
  pooled MCP connection (mcp_pool, same PoolKey + identity envelope as
  today); tool discovery is the pool's `tools/list`. It is an adapter, not a
  parallel path.
- `category()` moves off the trait — it becomes a manifest field (data).

## 2. Bundle format: tools as data + adapter binding

Manifest v2 grows (validated by an extended `validate_v2`):

```jsonc
{
  "slug": "slack", "version": "1.1.0",
  "category": "other",                       // new; default "other"
  "auth":  { "secret_names": ["bot_token", "base_url"], "identity_key": "email" },
  "settings": { "fields": [ /* unchanged FieldSpec[] */ ] },
  "tools": [                                 // full declarations, replaces the class map
    { "name": "conversations_list", "class": "read",
      "description": "List Slack channels (public and private the bot can see).",
      "parameters": { /* JSON Schema, today's ToolSpec.parameters */ } }
  ],
  "executor": { "kind": "adapter", "name": "slack", "api": 1 }
  // or { "kind": "mcp", "url": "…" }        // MCP demoted to one binding kind
}
```

Rules:

- Tool entries are the single source of truth. `in_code_manifest()` and the
  `(&str, &str)` class-pair lists die; class lives on the tool entry.
- An `adapter` binding must name an adapter the server ships, at the declared
  api version — unknown adapter or version mismatch fails closed at
  validate/install time. A bundle can never retarget to code the server
  doesn't have.
- Tool specs inside the manifest means the registry review (already bound to
  manifest + bundle sha256 via `reviewed_version` / `reviewed_bundle_sha256`)
  automatically covers the full declared tool surface.
- `tools.parameters` optional for MCP-bound bundles: an MCP adapter may
  discover specs live and overlay classes from the manifest entries (an entry
  with class but no parameters constrains class only).
- **Behavior change** for MCP-bound bundles: a live-discovered tool absent
  from the manifest is uncategorized and fails closed (policy floor `write`,
  never callable as `read`). Today `tool_class()` defaults undeclared tools
  to `read` — permissive by accident. Declared entries keep their class.
  Admins of existing MCP plugins must re-approve bundles whose manifests
  declare all tools they serve (the stale-approval mechanism already forces
  a re-review round-trip on republish).

## 3. Built-ins become embedded bundles

- Seven bundle JSONs at `crates/server/bundles/*.json`, embedded via
  `include_dir!`, validated at boot, seeded as catalog entries with
  `source = "embedded"`. Plain checked-in JSON (reviewable in diffs; no build
  -time generation).
- Embedded bundles need no registry review — they ship with the release, same
  trust level as today's compiled-ins.
- The existing shadowing rule generalizes and becomes the distribution story:
  an installed (web-downloaded or local) bundle of the same slug shadows the
  embedded one. Same format, same install path; "built-in" is now a
  distribution property, not an interface property.
- Catalog listing (`available` in the admin list) is derived from embedded
  bundles + installed approved bundles; `integration_names()` dies.

## 4. One resolution path

`resolve_plugins` collapses to one loop for every enabled row:

```
row → effective manifest (approved installed bundle > embedded bundle)
    → adapter by executor binding (adapter table | McpToolAdapter)
    → secrets presence check (unchanged)
    → PluginTurn (same journaled shape: namespaced specs, classes,
      row_config, secret_names, identity_key, guide_object_key)
```

`PluginExecutor::Rust` vs the MCP branch disappears — the snapshot records the
binding kind instead. Nothing downstream changes: policy filter, auto
disclosure tools, script API, audit, journaling all keep their shapes.

## 5. Admin surface (the originating feature)

- `GET /api/v1/admin/integrations/{id}/tools` — the full, **unfiltered**
  declared tool list: namespaced name, description, class, input schema.
  - Adapter-bound: reads the effective bundle manifest (works for disabled
    rows too — it's data).
  - MCP-bound: live `tools/list` via the pooled connection, classes overlaid
    from the manifest; disabled/not-configured rows report "not resolved"
    instead of connecting.
  - Broken plugin (MCP unreachable): the response carries the resolution
    error — never a silent empty list.
- The `available` catalog entries carry the same declared list for free
  (bundle data).
- UI: Tools table on the integration detail page — name, class badge,
  description (DataTable kit); tool policy editing stays as is, now visibly
  aligned with the declared classes.

## 6. Secrets, identity, audit — unchanged

Secret store (per-connector slug keys), identity envelope headers, acting-as
(admin-only override), policy classes, `integration.tool_called` audit events:
all keep their current contracts. The adapter boundary receives exactly what
`execute()` receives today.

## Migration plan (each phase keeps the suite green)

1. **Extract declarations**: tool specs move from `tools()` bodies into the
   seven embedded bundle JSONs; loader + boot validation; resolver reads tools
   from bundle data for built-ins. `Integration::tools()` and
   `in_code_manifest()` die. `category()` → manifest field.
2. **Adapters**: rename/split the trait to `ToolAdapter`; static adapter
   table; `McpToolAdapter` formalized; `resolve_plugins` collapses to the one
   loop; manifest gains `executor` binding + `tools[]` entries (`validate_v2`
   extension); registry review/install paths updated to the extended schema.
3. **Admin feature**: tools endpoint + detail-page Tools table + catalog
   tool lists; deploy + browser verification.
4. **Cleanup**: `integration_names()` removal, catalog from bundles,
   `PluginExecutor` simplification.

Phases 1–2 are mechanical splits of existing code: no db migrations, no wire
changes beyond the manifest schema (registry bundles are already
hash-reviewed; a schema bump re-reviews via the existing stale-approval
mechanism).

## Tests

- Existing 27 integration tests stay green throughout (resolver behavior
  preserved).
- Bundle validation: valid v3 manifest; unknown adapter name; api-version
  mismatch; tool entry without class; MCP entry constraining an undeclared
  tool.
- Shadowing: installed bundle overrides embedded same-slug; removing the
  installed bundle falls back to embedded.
- Resolver: adapter-bound and MCP-bound rows produce identical `PluginTurn`
  shapes; MCP class overlay; uncategorized MCP tool fails closed.
- Admin endpoint: unfiltered list for adapter-bound (incl. admin-class tools);
  disabled MCP row → "not resolved"; unreachable MCP → resolution error.

## Security notes

- Review still binds manifest + bundle hash; tool declarations are now inside
  the reviewed manifest — previously the class map was reviewed but specs were
  compiled-in and unreviewable for MCP plugins.
- Adapter bindings are version-pinned and fail closed; a republished bundle
  cannot silently change which server code runs its tools.
- Embedded bundles are release artifacts: changing them requires a server
  release, same as today's code changes.
