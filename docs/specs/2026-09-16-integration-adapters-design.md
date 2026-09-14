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
- `tools` optional for MCP-bound bundles: for MCP, the live `tools/list` is
  the discovery source; manifest entries are default classes only (an entry
  with class but no parameters prefills the class default only).
- **Policy model change**: today `tool_class()` defaults an MCP tool absent
  from the manifest to `read` — permissive by accident. Under the per-tool
  model (§6) a tool the admin has not configured is disabled by default;
  manifest defaults only prefill the configure-time form. The admin's
  per-tool configuration, not the manifest, is the source of truth for
  exposure and approval.

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

## 5. Admin surface: tool curation

The admin sees, per integration, **every tool it declares or serves**, and
decides per tool whether it is exposed and how it is approved.

- `GET /api/v1/admin/integrations/{id}/tools` — the full, **unfiltered**
  tool list with each tool's stored per-tool config (§6):
  - Adapter-bound: reads the effective bundle manifest (works for disabled
    rows too — it's data).
  - MCP-bound: live `tools/list` via the pooled connection, merged with the
    stored per-tool config; disabled/not-configured rows report "not
    resolved" instead of connecting.
  - Broken plugin (MCP unreachable): the response carries the resolution
    error — never a silent empty list.
- `PUT /api/v1/admin/integrations/{id}/tools/{tool}` — sets one tool's
  per-tool config (`enabled`, `approval`). Idempotent, audited.
- The `available` catalog entries carry their declared tool lists for free
  (bundle data).
- UI: Tools table on the integration detail page (DataTable kit) — name,
  class badge, description, enabled toggle, approval selector. MCP configure
  -time lists every live tool; drift lands as new disabled rows. Class
  badges stay visible so the admin sees the declared floor.

## 6. Policy model: per-tool admin curation

The admin's per-tool configuration is the single source of truth for
exposure and approval, for both kinds. Bundles declare defaults; nothing is
ever exposed that an admin (or a reviewed manifest, for zero-config
adapter-bound integrations) did not approve.

Stored per tool (JSON on the integration row's config):

```jsonc
{ "tools": {
    "post_message": { "enabled": true, "approval": "always_ask" },
    "conversations_history": { "enabled": false }
} }
```

- `enabled: bool` — off means the tool is not declared to the model and not
  callable via the script API at all. Not denied at call time — invisible.
- `approval: "default" | "always_ask"` — `default` follows the user's own
  approval policy (class-based, as today); `always_ask` forces a durable
  approval prompt on every call, even for a user whose policy would allow
  it. The Phase-2 approval gate slots the override in ahead of the user
  policy.

Defaults — one rule per kind, no background writes:

- **Adapter-bound** (declared in a reviewed manifest): absent from stored
  config = enabled + follow user policy. Zero-config behavior is identical
  to today. The manifest class stays the visibility floor: admin-class
  tools remain admin-gated, and per-tool settings can only tighten, never
  loosen above the class.
- **MCP-bound** (live discovery): absent from stored config = disabled
  (hidden). One rule covers configure time and drift — at initial connect
  every live tool is listed and the admin flips on what they want; a remote
  update later just adds rows in the disabled state.
- Saved selections survive bundle republishes: tools dropped from the new
  version vanish, new tools arrive disabled, existing selections carry over.

Enforcement points (all existing code paths, one filter change each):
turn-start resolution (`allowed_infos`/`tool_allowed` consults the per-tool
config), the script API tool list, and the approval gate (`always_ask`
override).

## 7. Secrets, identity, audit — unchanged

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
3. **Per-tool policy**: per-tool config storage on integration rows;
   `tool_allowed` + script API + approval gate consult it; MCP drift lands
   disabled; `PUT` endpoint.
4. **Admin feature**: tools endpoint + detail-page Tools table with
   enabled/approval controls + catalog tool lists; deploy + browser
   verification.
5. **Cleanup**: `integration_names()` removal, catalog from bundles,
   `PluginExecutor` simplification.

MCP-bound rows configured before phase 3 resolve fail-closed (their tools
come up disabled) until an admin curates them — the same one-time
re-confirmation the migration-0038 fail-closed transition already set as
the pattern.

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
  shapes; MCP class overlay.
- Per-tool policy: disabled tool absent from model tool list + script API;
  `always_ask` forces an approval prompt for an allow-all user; drift tool
  lands disabled; selections survive a republish (dropped tool vanishes, new
  tool arrives disabled).
- Admin endpoint: unfiltered list for adapter-bound (incl. admin-class tools);
  disabled MCP row → "not resolved"; unreachable MCP → resolution error.

## Future direction (out of scope, recorded)

The end-state concept for tool consumption is a **persistent REPL** (likely
Python, inspired by Prime Intellect's `prime-agent`: one model tool — a
persistent kernel — with tools, subagents, and context manipulated as code,
not as per-call schemas). In that world the connected integrations compose a
**namespace hierarchy** the agent scripts against: integration → tool group
→ tool, like Python packages → subpackages → functions (e.g.
`slack.channels.list(...)`, `slack.chat.post_message(...)`). Everything this
spec builds toward that world: tools as data (introspectable, enumerable at
runtime), one uniform adapter contract (any tool source can be projected
into the namespace), per-tool admin curation (what enters the namespace).
The REPL and namespace projection are separate future work; the namespacing
wire format (`int_<slug>_<tool>`) stays until then.

## Security notes

- Review still binds manifest + bundle hash; tool declarations are now inside
  the reviewed manifest — previously the class map was reviewed but specs were
  compiled-in and unreviewable for MCP plugins.
- Nothing is ever exposed unapproved: adapter-bound tools are covered by the
  reviewed manifest (zero-config default) or explicit admin enablement; MCP
  tools require explicit admin enablement, and drift lands disabled.
- Adapter bindings are version-pinned and fail closed; a republished bundle
  cannot silently change which server code runs its tools.
- Embedded bundles are release artifacts: changing them requires a server
  release, same as today's code changes.
