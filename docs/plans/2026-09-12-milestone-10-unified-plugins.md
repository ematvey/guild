# Milestone 10 — Unified plugin interface + built-in connectors

**Goal:** Built-in (compiled-in Rust) and pluggable (MCP-over-HTTP)
integrations sit behind one interface — same manifest, tool classes,
secrets store, org policy, disclosure, script API, audit. Then the
services Guild actually uses become real connectors, seeded with the
credentials from internal project, and everything is tested: unit, suite, deployed
live smoke against the real vendor APIs.

**Spec base:** `docs/specs/2026-09-12-integration-plugins-design.md`
(milestone 9). This plan extends it; no spec rewrite.

**Worktree:** `~/worktrees/guild-integrations2`, branch
`integrations-v2-connectors`.

## Verification gates (global)

- `cargo test --workspace` and `cargo test -p guild-server --features
  test-support` and `cargo clippy --workspace -- -D warnings` all clean.
- `cargo fmt --check` is NOT a gate (toolchain artifact).
- Secrets never appear in API responses, logs, tool results, events, or
  committed files. Real internal project credential values are loaded only at the
  live step by the orchestrator via the admin API — never in code, tests
  (wiremock fixtures use fake tokens), or docs.
- Comment style: present tense, what code IS and DOES, no history.

## Lane CORE — unify built-in + MCP plugins under one interface

Current state (milestone 9): `ServerExecutor::Rust | Mcp` shares
execution, but built-ins bypass manifest/classes/secrets/policy: they are
disclosed unfiltered, absent from the script API (`turns()` is MCP-only),
absent from the audit path, and take secrets from plaintext config
(superproxy `token`).

Task C1 — trait + manifest:
- `Integration` gains `fn manifest(&self) -> BundleManifest` returning an
  in-code manifest (kind `integration`, slug = name, semver, description,
  `auth.secret_names`, `tools.classes`). No `mcp` field; no registry
  bundle required.
- `Integration::execute` gains a `secrets: &[(String, String)]` argument.
  Built-ins read credentials from the resolved store values; config keeps
  non-secret settings (urls, ids). Backwards compat: superproxy falls
  back to config `token` when no secret is stored (existing config keeps
  working); new integrations require secrets only.
- Registry validation rules for manifests still apply where relevant
  (tool classes legal, namespaced name length) — reuse, don't fork.

Task C2 — unified resolution + surfaces:
- One turn-start snapshot type (extend `McpPluginTurn` with the executor
  kind, or a sibling type) covering BOTH kinds. Built-ins get:
  tool list from `tools(config)` with classes from the in-code manifest,
  the same `int_<slug>_list_tools` / `int_<slug>_guide` auto-tools,
  the same policy filter (`mcp_tool_allowed` semantics generalized),
  the same prompt index line.
- `resolve_mcp_plugins` + `resolve_server_tools` collapse into one
  resolver; `restate.rs` and `http/integration_tools.rs` consume the
  unified snapshot. Built-in rows become script-callable
  (`POST /api/v1/integrations/{slug}/tools/{tool}`) and audited
  (`integration.tool_called`) exactly like MCP plugins.
- Admin enable gate: a built-in row can only be enabled when its declared
  secrets are present (same rule as MCP plugins); secrets CRUD works for
  built-in slugs. `list_integrations` (script API) includes built-ins.

Task C3 — tests:
- A fake built-in integration in server tests exercising: class
  enforcement (member vs admin), secrets resolution into execute, script
  API call + audit, auto-tools. Existing searxng/superproxy/mcp tests
  stay green.

## Connector lanes (parallel, after CORE)

Each lane: implement the connector as a built-in plugin under the
unified interface, register in `integration_by_name`, wiremock-based
tests per endpoint family, clippy-clean. Tool names are the raw names
(Guild namespaces them). Keep tool sets small and useful; every tool
gets a manifest class. Config keys are documented in the module doc
comment; secret keys must match `auth.secret_names` exactly.

### Lane SLACK — `slack`
- Secrets: `bot_token`, `webhook_url` (slack-webhook folded in).
- Tools: `conversations_list` (read), `conversations_history` (read),
  `users_list` (read), `post_message` (write: channel + text, Web API),
  `post_webhook` (write: text to the incoming webhook).
- Slack Web API `https://slack.com/api/...`, `Authorization: Bearer`.
- Config: none required.

### Lane GIT — `github`, `gitlab`
- github secrets: `token`. Tools: `search_repositories` (read),
  `list_issues` (read), `list_pulls` (read), `get_file` (read),
  `create_issue` (write).
  REST `https://api.github.com`, `Authorization: Bearer`, `User-Agent`
  header required.
- gitlab secrets: `token`. Tools: `list_projects` (read),
  `list_issues` (read), `list_mrs` (read), `create_issue` (write).
  REST `https://gitlab.com/api/v4`, `PRIVATE-TOKEN` header (config may
  override base URL for self-hosted).

### Lane ATLASSIAN — `atlassian`
- Secrets: `site` (e.g. `https://org.atlassian.net`), `email`, `token`
  (basic auth `email:token`).
- Tools: `jira_search` (read, JQL), `jira_get_issue` (read),
  `confluence_search` (read, CQL), `confluence_get_page` (read),
  `confluence_create_page` (write).
- REST `/rest/api/3/...` and `/wiki/rest/api/...` v2 endpoints.

### Lane GOOGLE — `google_workspace`
- Secrets: `service_account_json` (full JSON string), `admin_email`
  (domain-wide delegation subject default).
- Auth: service account JWT (RS256) → token exchange at
  `https://oauth2.googleapis.com/token` with `sub` = acting identity.
  Acting identity resolution: envelope `acting_as` when present, else
  `admin_email`. Auth kind `org_secret_impersonated`, `identity_key:
  email`. Cache access tokens in the connector until expiry (in-process
  cache; no pool).
- Tools: `gmail_search` (read), `gmail_get_message` (read),
  `calendar_list_events` (read), `drive_search` (read),
  `directory_users` (read).
- Scopes: gmail.readonly, calendar.readonly, drive.readonly,
  admin.directory.user.readonly.
- Use `jsonwebtoken` for RS256 signing (add to guild-server deps if
  absent).

### Lane CRM — `hubspot`, `langfuse`
- hubspot secrets: `token` (private app). Tools: `search_contacts` (read),
  `search_companies` (read), `search_deals` (read), `update_deal`
  (write). CRM v3 `/crm/v3/objects/.../search`, `Authorization: Bearer`.
- langfuse secrets: `host`, `public_key`, `secret_key` (basic auth).
  Tools: `list_traces` (read), `get_trace` (read), `list_prompts` (read).
  Public API `/api/public/...`.

## Gates

- G1 (after CORE): suite + clippy green in the worktree; review the
  unified surface against this plan.
- G2 (fan-in, after all connector lanes): full suite + clippy + deploy
  compose on :18080 + health.
- SHIP: merge to master (absorb parallel desktop WIP as before), PLAN.md
  entry, then live step:
  1. Admin auth on :18080 (bootstrap via guild postgres if no creds).
  2. Load real secrets from `~/acme/internal project/.credentials/` per
     connector (orchestrator only, values never echoed).
  3. Enable every connector per org; verify the enable gate passes.
  4. Live smoke each connector: one read-only real call through the
     script API with a real response body check (message ids, issue
     numbers, file paths — the evidence).
  5. One write-path real call where safe (e.g. slack post to a test
     channel) — optional, prefer read-only.
- Completion requires: all connectors live-smoked green + full suite
  green + deployed.

## Constraints

- No trigger runtime work this milestone (internal project watch/poll stays out).
- No webui redesign; only fix what breaks from data-driven changes.
- Registry bundle skills (cookbooks) are out of scope for connectors;
  manifest `skills` stays empty.
