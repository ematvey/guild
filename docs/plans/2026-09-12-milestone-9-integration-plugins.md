# Milestone 9 — Integration plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Org integrations become installable plugins: an integration's MCP
server (streamable HTTP) is the plugin contract; Guild executes it
server-side, controls access per connector (tool classes + org policy),
resolves per-call identity (impersonation), and exposes the same tools to
scripts over HTTPS with progressive disclosure.

**Architecture:** Manifest v2 on the existing registry bundle (optional
fields, serde-default) declares mcp url, auth shape, tool classes,
triggers, skills. The worker resolves enabled integrations at turn start
(journaled), connects to MCP servers through a cached connection pool in
AppState, exposes namespaced tools + two auto-tools per integration
(`int_<slug>_list_tools`, `int_<slug>_guide`), and enforces policy before
execution. A new `http/integration_tools.rs` module mirrors the same
enforcement for script callers. Secrets live encrypted (AES-256-GCM,
existing `crypto.rs`) in a new `integration_secrets` table.

**Tech Stack:** Rust (axum, sqlx, rmcp 3.2 client+server transports,
restate-sdk), Postgres migrations, vitest/vite for apps/webui build.

**Spec:** `docs/specs/2026-09-12-integration-plugins-design.md` (read both;
the plan argues from the spec).

## Global Constraints

- Verification gates: `cargo test --workspace` and
  `cargo clippy --workspace -- -D warnings` both clean. (`cargo fmt
  --check` is NOT a gate: master is not fmt-clean under installed
  rustfmt 1.9.0.)
- Existing tests must stay green: registry v1 install (routine.json),
  admin integrations CRUD, mcp fixtures in app-server.
- No placeholder steps; every code step has real code in this plan.
- Secrets never appear in API responses, logs, tool results, or events.
- Tool names: `int_<slug>_<tool>`; reject >64 chars at install.
- Tool classes: `read` (default) | `write` | `admin`. Org policy may
  tighten, never loosen, manifest classes.
- Repo comment style: comments describe what code IS and DOES, present
  tense; no history narration (see workspace AGENTS.md).

---

## Lane CORE — manifest v2 (crates/guild-core)

### Task C1: BundleManifest v2 + validation

**Files:**
- Modify: `crates/guild-core/src/registry.rs`
- Test: `crates/guild-core/src/registry.rs` (mod tests)

**Interfaces:**
- Produces: `BundleManifest` gains optional fields
  `mcp: Option<McpManifest>`, `auth: Option<AuthManifest>`,
  `tools: Option<ToolsManifest>`, `triggers: Vec<TriggerSpec>`
  (serde default), `skills: Vec<String>` (serde default). New types:
  `McpManifest { url: String }`, `AuthManifest { kind: String
  (default "org_secret"), secret_names: Vec<String> (default),
  identity_key: String (default "email") }`, `ToolsManifest {
  classes: BTreeMap<String, String> (default) }`, `TriggerSpec {
  kind: String, name: Option<String>, trigger_config: serde_json::Value,
  prompt: String, model: String, allowed_tools: Option<Vec<String>> }`.
  New fns: `pub fn validate_v2(m: &BundleManifest) -> anyhow::Result<()>`
  and `pub fn tool_class(m: &BundleManifest, tool: &str) -> &'static str`
  returning "read"/"write"/"admin" (unknown tool → "read").

- [ ] **Step 1: Write failing tests** (append to mod tests):

```rust
fn v2_manifest() -> BundleManifest {
    serde_json::from_value(serde_json::json!({
        "kind": "integration", "slug": "hubspot", "version": "1.0.0",
        "description": "HubSpot CRM tools",
        "mcp": { "url": "https://mcp.example.com/mcp" },
        "auth": { "kind": "org_secret_impersonated",
                  "secret_names": ["sa_json"], "identity_key": "email" },
        "tools": { "classes": { "search_contacts": "read",
                                "update_deal": "write" } },
        "triggers": [{ "kind": "webhook", "prompt": "digest",
                       "model": "gpt-4o-mini" }],
        "skills": ["hubspot-cookbook"]
    })).unwrap()
}

#[test]
fn v2_manifest_roundtrip_and_validation() {
    let m = v2_manifest();
    validate_v2(&m).unwrap();
    assert_eq!(m.mcp.as_ref().unwrap().url, "https://mcp.example.com/mcp");
    assert_eq!(tool_class(&m, "search_contacts"), "read");
    assert_eq!(tool_class(&m, "update_deal"), "write");
    assert_eq!(tool_class(&m, "unknown_tool"), "read");
}

#[test]
fn v2_validation_rejects_bad_fields() {
    let mut m = v2_manifest();
    m.mcp.as_mut().unwrap().url = "ftp://x".into();
    assert!(validate_v2(&m).is_err());
    let mut m = v2_manifest();
    m.auth.as_mut().unwrap().kind = "magic".into();
    assert!(validate_v2(&m).is_err());
    let mut m = v2_manifest();
    m.tools.as_mut().unwrap().classes.insert("t".into(), "sudo".into());
    assert!(validate_v2(&m).is_err());
    let mut m = v2_manifest();
    m.mcp.as_mut().unwrap().url =
        "https://x/".into();
    let mut long = BundleManifest { slug: m.slug.clone(), ..v2_manifest() };
    long.tools.as_mut().unwrap().classes.insert(
        "a_very_long_tool_name_exceeding_sixty_four_characters_limit_x".into(), "read".into());
    assert!(validate_v2(&long).is_err());
}

#[test]
fn v1_manifest_still_validates() {
    let m = BundleManifest { kind: "integration".into(), slug: "digest".into(),
        version: "0.1.0".into(), description: String::new(),
        dependencies: vec![], mcp: None, auth: None, tools: None,
        triggers: vec![], skills: vec![] };
    validate_v2(&m).unwrap();
    assert!(m.mcp.is_none());
}
```

- [ ] **Step 2:** `cargo test -p guild-core` → new tests FAIL (fields don't exist).
- [ ] **Step 3: Implement** — add the structs (all `Debug, Clone, Serialize,
  Deserialize, PartialEq, Default` where sensible, serde defaults) and:

```rust
const TOOL_CLASSES: [&str; 3] = ["read", "write", "admin"];
const AUTH_KINDS: [&str; 3] =
    ["org_secret", "org_secret_impersonated", "per_user_token"];

pub fn validate_v2(m: &BundleManifest) -> anyhow::Result<()> {
    validate_manifest(m)?; // existing fn
    if let Some(mcp) = &m.mcp {
        anyhow::ensure!(
            mcp.url.starts_with("http://") || mcp.url.starts_with("https://"),
            "mcp.url must be an absolute http(s) URL"
        );
er    }
    if let Some(auth) = &m.auth {
        anyhow::ensure!(
            AUTH_KINDS.contains(&auth.kind.as_str()),
            "auth.kind must be org_secret, org_secret_impersonated, or per_user_token"
        );
        anyhow::ensure!(
            auth.identity_key == "email" || auth.identity_key.is_empty(),
            "auth.identity_key supports only email in v1"
        );
    }
    if let Some(tools) = &m.tools {
        for (name, class) in &tools.classes {
            anyhow::ensure!(
                TOOL_CLASSES.contains(&class.as_str()),
                "tool class for {name} must be read, write, or admin"
            );
            anyhow::ensure!(
                name.len() <= 64 - "int_".len() - m.slug.len() - 2,
                "tool name {name} too long for namespacing under {}",
                m.slug
            );
        }
    }
    for t in &m.triggers {
        anyhow::ensure!(
            matches!(t.kind.as_str(), "webhook" | "interval"),
            "trigger kind must be webhook or interval"
        );
        anyhow::ensure!(!t.prompt.is_empty(), "trigger prompt is empty");
        anyhow::ensure!(!t.model.is_empty(), "trigger model is empty");
    }
    Ok(())
}

pub fn tool_class(m: &BundleManifest, tool: &str) -> &'static str {
    m.tools.as_ref()
        .and_then(|t| t.classes.get(tool).map(|c| match c.as_str() {
            "write" => "write", "admin" => "admin", _ => "read" }))
        .unwrap_or("read")
}
```

(Remove the stray `er` typo — it is there to catch copy-paste; final code
must compile without it.)

- [ ] **Step 4:** `cargo test -p guild-core` → PASS. Commit
  `core: integration bundle manifest v2 (mcp/auth/tools/triggers/skills)`.

---

## Lane STORE — secrets, registry install, admin + script API (crates/server)

### Task S1: integration_secrets store + migration

**Files:**
- Create: `crates/server/migrations/0029_integration_secrets.sql`
- Modify: `crates/server/src/store/mod.rs` (register migration + module)
- Create: `crates/server/src/store/integration_secrets.rs`
- Test: `crates/server/tests/integration_secrets.rs` (feature test-support)

**Interfaces:**
- Produces: `SecretRow { name, updated_at }`,
  `IntegrationSecretStore { upsert(org, integration, name, plaintext),
  delete(org, integration, name), list(org, integration) -> Vec<SecretRow>,
  resolve(org, integration, names: &[String]) ->
  Result<Vec<(String, String)>, ApiError /*MissingSecrets(Vec<String>)*/> }`
  where resolve decrypts with `state.master_key()`.
  Migration SQL (exact):

```sql
CREATE TABLE IF NOT EXISTS integration_secrets (
    org_id UUID NOT NULL,
    integration TEXT NOT NULL,
    name TEXT NOT NULL,
    secret_enc TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (org_id, integration, name)
);
```

- [ ] **Step 1:** failing test (follow the pattern in
  `crates/server/tests/integration_install.rs` for store/pool bootstrap):
  upsert → list shows name + updated_at (no value) → resolve returns
  decrypted pairs → resolve with a missing declared name errors with
  MissingSecrets(["missing"]) → delete removes.
- [ ] **Step 2:** run `cargo test -p guild-server --features test-support
  --test integration_secrets` → FAIL.
- [ ] **Step 3:** implement store + register `0029` in `store/mod.rs`
  migrations list and `pub mod integration_secrets;`. Follow
  `store/integrations.rs` style (sqlx, ApiError).
- [ ] **Step 4:** test PASS. Commit `server: encrypted integration secret store (0029)`.

### Task S2: registry v2 publish validation + install path

**Files:**
- Modify: `crates/server/src/http/registry.rs` (publish + install)
- Test: `crates/server/tests/integration_install.rs` (extend)

**Interfaces:**
- Consumes: `guild_core::registry::{BundleManifest, validate_v2,
  read_bundle_file}`.
- Produces: publish rejects invalid v2 fields (400). Install for a v2
  bundle with `mcp` creates/leaves a disabled `integrations` row with
  `config = {"mcp": {"url": …}, "auth": {…}, "tool_policy": {}}` and
  creates disabled routines from `triggers` (same shape as the
  routine.json path; webhook token via `new_hook_token()`).
- [ ] **Step 1:** failing tests: (a) publish v2 bundle with
  `auth.kind = "magic"` → 400; (b) install v2 bundle → `GET
  /admin/integrations` (admin session) lists `hubspot` disabled with
  `mcp.url`; enabling fails while `secret_names` are unstored (covered
  fully in S3's enable-gate test — here assert the row config shape);
  routines exist and are disabled.
- [ ] **Step 2:** run → FAIL. **Step 3:** implement: in `publish`, after
  `validate_manifest` call `validate_v2` when `kind == "integration"`;
  in `install`, branch on `manifest.mcp.is_some()` before the existing
  routine.json branch; keep the v1 path untouched. **Step 4:** PASS,
  commit `server: registry install for v2 integration bundles`.

### Task S3: admin API — policy, enable gate, secrets endpoints

**Files:**
- Modify: `crates/server/src/http/admin.rs`
- Test: `crates/server/tests/admin_integration_policy.rs` (new, feature test-support)

**Interfaces:**
- Consumes: S1 store; `guild_core::registry::validate_v2`.
- Produces:
  - `GET /api/v1/admin/integrations` — rows (config only; never
    secrets) + `available` = compiled-in kinds ∪ installed v2 plugins
    not yet configured (registry `integration` items with approved
    status and manifest.mcp, `{name, category: "mcp"}`).
  - `PUT /api/v1/admin/integrations/{name}` — validates `config.mcp.url`
    absolute http(s) when present, `tool_policy` role keys ⊆
    {member, admin} and class lists ⊆ {read, write, admin};
    `enabled: true` requires mcp url and every manifest
    `auth.secret_names` present in `integration_secrets` (409
    `missing_secrets` with the missing names otherwise).
  - `PUT /api/v1/admin/integrations/{name}/secrets` `{name, value}` —
    upsert (any admin).
  - `DELETE /api/v1/admin/integrations/{name}/secrets/{secret}` —
    remove; if the integration is enabled and the secret was declared,
    auto-disable the row.
  - `GET /api/v1/admin/integrations/{name}/secrets` — names +
    updated_at only.
- [ ] **Step 1:** failing tests: policy validation 400s; enable gate 409
  listing missing secrets; secrets upsert/list/delete lifecycle;
  delete of declared secret auto-disables.
- [ ] **Step 2:** FAIL → **Step 3:** implement in admin.rs (follow the
  existing `upsert_integration` style). **Step 4:** PASS, commit
  `server: admin api for mcp integration policy, enable gate, secrets`.

### Task S4: tool HTTP API for scripts

**Files:**
- Create: `crates/server/src/http/integration_tools.rs`
- Modify: `crates/server/src/http/mod.rs` (routes), `crates/server/src/lib.rs`
- Test: `crates/server/tests/integration_tools_api.rs` (feature test-support)

**Interfaces:**
- Consumes: S1 secrets, enabled `integrations` rows, manifest from
  registry (via `store.registry()`), enforcement from
  `crate::integrations` (W1's shared fns — see Interfaces note in W1;
  if W1 hasn't landed, this task imports `enforce_class` and
  `resolve_acting_as` from `crate::integrations` with the signatures in
  Task W1 and the lanes merge in order W1 → S4).
- Produces (all under member/admin session or org API key auth — reuse
  the auth extractor used by the OpenAI-compatible endpoint):
  - `GET /api/v1/integrations` → `{items: [{slug, description, tool_count}]}`
  - `GET /api/v1/integrations/{slug}/tools` →
    `{tools: [{name: "int_<slug>_<tool>", description, parameters, class}]}`
  - `POST /api/v1/integrations/{slug}/tools/{tool}` → executes with the
    identity envelope (caller from session user email / org key with
    optional `x-guild-acting-as` header, admin-only), audit event
    `integration.tool_called` with `via: "script"`, returns
    `{ok, content, meta}` | `{ok: false, error}`.
- [ ] **Step 1:** failing tests: authz matrix — 401 unauthenticated, 403
  non-admin calling write tool under default policy, admin allowed,
  acting-as override by non-admin 403, by admin OK; disabled
  integration 404; fixture MCP server (rmcp streamable-http server
  transport in-process, as in Task W1) answers the call.
- [ ] **Step 2:** FAIL → **Step 3:** implement module + wire routes.
  **Step 4:** PASS, commit `server: script-facing integration tool api`.

---

## Lane WORKER — MCP execution, disclosure, identity (crates/server)

### Task W1: integrations.rs — MCP plugin executor + enforcement core

**Files:**
- Modify: `crates/server/src/integrations.rs`
- Create: `crates/server/src/worker/mcp_pool.rs`
- Test: `crates/server/tests/mcp_plugin.rs` (feature test-support)

**Interfaces:**
- Produces (signatures the other tasks import):
  - `pub enum ServerExecutor { Rust(Arc<dyn Integration>),
    Mcp(McpEndpoint) }` where
    `McpEndpoint { slug: String, url: String,
    secrets: Vec<(String, String)>, manifest: BundleManifest }`.
    `ServerTool { spec: ToolSpec, executor: ServerExecutor, config:
    serde_json::Value }` (replaces `integration` field; `resolve_server_tools`
    unchanged for Rust rows, extended for MCP rows).
  - `pub fn enforce_class(manifest: &BundleManifest, org_policy:
    &Option<Value>, role: &str, tool: &str) -> bool` — spec §6 rule
    (manifest class is the floor; org policy tightens).
  - `pub fn resolve_acting_as(caller_email: Option<&str>, override_:
    Option<&str>, is_admin: bool) -> Result<Option<String>, ()>`.
  - `pub fn envelope_headers(call_id: &Uuid, org: &Uuid, caller:
    Option<&Uuid>, acting_as: Option<&str>, secrets:
    &[(String, String)]) -> HeaderNameMap` — builds
    `x-guild-*` + `x-guild-secret-<name>` headers.
  - `worker/mcp_pool.rs`: `pub struct McpPool` —
    `Mutex<HashMap<PoolKey, PoolEntry>>`, `PoolKey {slug, url,
    acting_as: Option<String>, secrets_fingerprint: u64}`;
    `pub async fn get_or_connect(&self, key, cfg) ->
    anyhow::Result<Peer<RoleClient>>` using
    `StreamableHttpClientTransport::with_config(
    StreamableHttpClientTransportConfig::with_uri(url)
    .custom_headers(headers))`; entries evicted when unused > 10 min
    (scan on insert). AppState gains `pub mcp_pool: Arc<McpPool>`
    (initialized in `state.rs`).
  - Fixture MCP server for tests: rmcp
    `transport-streamable-http-server` — an in-process server exposing
    `echo(text) -> text` and `admin_only_op()`; bound on 127.0.0.1:0.
- [ ] **Step 1:** failing tests: pool connects to fixture and lists
  tools; `enforce_class` matrix (manifest floor / policy tighten /
  unknown tool default read); `resolve_acting_as` (self OK, non-admin
  override Err, admin override Ok); envelope headers contain secrets +
  ids.
- [ ] **Step 2:** FAIL → **Step 3:** implement. **Step 4:** PASS, commit
  `server: mcp plugin executor, identity envelope, class enforcement`.

### Task W2: restate.rs — resolution, disclosure tools, audit

**Files:**
- Modify: `crates/server/src/worker/restate.rs` (turn-start resolution +
  `server_tool_step`), `crates/server/src/http/mod.rs` if needed
- Test: `crates/server/tests/mcp_plugin.rs` (extend) +
  `crates/server/tests/disclosure.rs` (new)

**Interfaces:**
- Consumes: W1 executor + pool; S1 secrets; system prompt builder
  (`build_system_prompt`).
- Produces:
  - Turn-start: after the existing journaled `list_enabled` for Rust
    integrations, resolve MCP rows (enabled + config.mcp.url): decrypt
    secrets, connect via pool (outside journal), `list_tools` inside
    journal (snapshot `Vec<ToolSpec>` journaled). Namespaced names.
    Broken server → skip with warning (spec §8).
  - Auto-tools per MCP integration: `int_<slug>_list_tools` (returns
    the journaled, policy-filtered list for the caller's role),
    `int_<slug>_guide` (returns cookbook SKILL.md text from object
    storage via the registry bundle; "not available" when no skills).
    Both are Guild-provided, never sent to the MCP server.
  - System prompt index: one line per enabled MCP integration (§7.1) —
    extend `build_system_prompt` with an `integrations_index: &str`.
  - `server_tool_step`: dispatches `ServerExecutor::Rust` as today;
    `ServerExecutor::Mcp` → journaled call through the pool peer with
    envelope headers (headers are per-connection: the pool key already
    contains acting_as; a changed acting_as creates a new pooled
    connection), then audit org event `integration.tool_called`
    `via: "chat"`.
- [ ] **Step 1:** failing tests: fixture MCP plugin end-to-end through a
  chat turn against the test server (model provider stubbed — follow
  `crates/server/tests/integrations.rs` harness): model requests
  `int_hubspot_echo`, result round-trips; `list_tools` respects role
  policy; guide tool returns SKILL.md content; audit event exists;
  unreachable mcp url → turn proceeds without the plugin's tools.
- [ ] **Step 2:** FAIL → **Step 3:** implement. **Step 4:** PASS, commit
  `server: chat-loop mcp tools, disclosure tools, identity envelope, audit`.

---

## Lane UI — settings integrations section (apps/webui)

### Task U1: mcp integration rows + secrets + policy editor (minimal)

**Files:**
- Modify: `apps/webui/src/views/settings/sections/IntegrationsSection.tsx`
  (+ its api client module under `apps/webui/src/` — follow the file
  that already calls `/admin/integrations`)

**Interfaces:**
- Consumes: S3 endpoints.
- Produces: for a row whose config has `mcp`: show url + secret names
  (+ updated_at), an add/replace secret form (name + value, write-only),
  a tool-policy editor (per role: checkbox list of read/write/admin),
  Edit/Save/Cancel + two-step confirm consistent with the admin state
  machine (PLAN.md: uniform admin state machine).
- [ ] **Step 1:** implement following the existing section's list/edit
  pattern. **Step 2:** `npm run build` (or the repo's webui build
  script) succeeds; click-through is a follow-up per PLAN.md
  convention. Commit `webui: mcp integration secrets + policy editor`.

---

## Gates and ship

### Task G1: review gate (per lane)

- [ ] Orchestrator reviews each lane diff against the spec (§3–§9);
  send-backs create new attempts (dagr).

### Task G2: full verification

- [ ] `cargo test --workspace` green on the merged branch.
- [ ] `cargo clippy --workspace -- -D warnings` clean.
- [ ] `cargo test -p guild-server --features test-support` green.

### Task SHIP: merge + deploy

- [ ] Merge `integrations-plugins` → master (ff or merge commit).
- [ ] `cd ~/guild/deploy/compose && docker compose build server &&
  docker compose up -d server` (embed-at-build-time model — see
  `docs/deploy-nuances.md`).
- [ ] Smoke: health endpoint + `GET /api/v1/admin/integrations`
  includes `available` list.
