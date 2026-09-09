# Guild Milestone 2 — Desktop Agent Implementation Plan

**Status: COMPLETE** (2026-09-09, branch `feat/milestone-2`). Agent loop +
tools + approvals + MCP + skills all covered by automated end-to-end tests
against the real server stack (testcontainers + scripted providers). Desktop
wiring verified under xvfb (window opens, engine spawns); interactive
click-through in the real window remains for a human.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The desktop agent works like codex/cowork: given a project dir and a
prompt, it loops (model → tools → model), edits files, runs commands behind
approvals, uses MCP tools and local skills — all through the org gateway.

**Architecture:** Extend the gateway protocol with tool calling (request
`tools`, stream event `tool_call`, `tool_choice`). Agent loop lives in
guild-core, driven by app-server; approvals pause the loop via a oneshot
answered by a new `approve` JSON-RPC method. MCP tools come from `rmcp`
(stdio + streamable HTTP). Skills are SKILL.md files read from local dirs and
surfaced as agent context. Server gains a message-append endpoint so the
agent can persist tool interactions.

**Tech Stack:** existing workspace; adds `rmcp` (official MCP Rust SDK),
`jsonschema` (tool input validation), `ignore` + `regex` (glob/grep tools).

**Spec:** `docs/specs/2026-09-09-guild-design.md` (§3.2, §4.2, §6; milestone 2
in §10)

## Global Constraints

- Same crate boundaries; guild-core stays storage-agnostic and UI-agnostic.
- Every new JSON-RPC method and API shape goes through the `protocol` crate
  (`PROTOCOL_VERSION` bumps to 2 only if wire-breaking; additive changes keep 1).
- Tool results — including failures — reach the model as tool messages, never
  crash the loop (spec §7).
- Approvals: per-tool policy (always/never/ask) per session; `run_command`
  defaults to `ask`, read-only tools default to `allow` (spec §3.2).
- All new server endpoints org-scoped; tests use testcontainers/wiremock.
- No server-side execution, no registry changes in this milestone (M3+).

---

### Task 1: protocol — tool-calling shapes

**Files:**
- Modify: `crates/protocol/src/api.rs`
- Test: `crates/protocol/src/api.rs` (inline)

**Interfaces:**
- Produces:
  - `ToolSpec { name: String, description: String, parameters: serde_json::Value }` (JSON Schema)
  - `ToolCall { id: String, name: String, arguments: serde_json::Value }`
  - `Message` gains `tool_calls: Option<Vec<ToolCall>>` and `tool_call_id: Option<String>` (roles: assistant with tool_calls, tool with tool_call_id)
  - `ChatCompletionRequest` gains `tools: Option<Vec<ToolSpec>>`
  - `StreamEvent::ToolCallDelta { index: u32, id: Option<String>, name: Option<String>, arguments_delta: String }` and `StreamEvent::ToolCallDone { call: ToolCall }` — argument fragments accumulate client-side

- [x] **Step 1: Failing round-trip tests** — serialize assistant message with tool_calls; StreamEvent tagged variants round-trip.
- [x] **Step 2: Run, FAIL** (`cargo test -p protocol`).
- [x] **Step 3: Implement** — additive serde (`skip_serializing_if` on new fields keeps old wire shape).
- [x] **Step 4: Run, PASS + clippy.**
- [x] **Step 5: Commit** — `feat(protocol): tool-calling shapes`

### Task 2: guild-core providers — tools in request and stream

**Files:**
- Modify: `crates/guild-core/src/provider/{mod,openai,anthropic}.rs`
- Test: `crates/guild-core/tests/provider_tools.rs`

**Interfaces:**
- Consumes: Task 1 types.
- Produces: `ProviderRequest.tools: Option<&'a [ToolSpec]>`; OpenAI adapter maps `ToolSpec`→`{"type":"function","function":{...}}`, parses `delta.tool_calls` fragments (accumulate by index: id/name/`function.arguments` string concat, emit `ToolCallDelta`; on finish_reason `tool_calls` emit `ToolCallDone`); Anthropic adapter maps to `{"name","description","input_schema"}`, parses `content_block_start` (type `tool_use` → id/name) + `input_json_delta` → `ToolCallDelta`, `content_block_stop` → `ToolCallDone` with parsed arguments.

- [x] **Step 1: Failing fixture tests** (wiremock SSE bodies with tool fragments, both adapters).
- [x] **Step 2: FAIL.**
- [x] **Step 3: Implement** adapters.
- [x] **Step 4: PASS + clippy.**
- [x] **Step 5: Commit** — `feat(core): tool-calling in openai/anthropic adapters`

### Task 3: gateway — tools pass-through + agent history persistence

**Files:**
- Modify: `crates/server/src/http/gateway.rs`, `crates/server/src/http/chats.rs`, `crates/server/src/store/chats.rs`
- Test: `crates/server/tests/gateway_tools.rs`

**Interfaces:**
- Produces:
  - `POST /api/v1/gateway/chat` accepts `tools`; stream includes tool-call events; assistant messages persist `tool_calls` into `messages.tool_calls` JSONB (protocol shape).
  - `POST /api/v1/chats/:id/messages` (auth) — body `{ role: "tool", content, tool_call_id }` or any role — appends a message the client already produced (tool results, retries). Org-scoped; validated role.
  - `store::chats::append_message` extended: `tool_calls: Option<&[protocol::api::ToolCall]>`, `tool_call_id: Option<&str>` columns.
  - The "append last user message" rule from M1 stays: only append when `last.role == "user"`.

- [x] **Step 1: Failing tests** — wiremock provider returning a tool call; assert `ToolCallDelta`/`ToolCallDone` in stream, assistant message persisted with tool_calls; POST tool message persists; org isolation on the new endpoint.
- [x] **Step 2: FAIL.**
- [x] **Step 3: Implement.**
- [x] **Step 4: PASS + clippy.**
- [x] **Step 5: Commit** — `feat(server): gateway tool calling + client-side message persistence endpoint`

### Task 4: guild-core — tool trait and built-in tools

**Files:**
- Create: `crates/guild-core/src/tools/mod.rs` (trait + registry + schemas), `crates/guild-core/src/tools/fs.rs` (read_file, write_file, edit_file, glob, grep), `crates/guild-core/src/tools/shell.rs` (run_command), `crates/guild-core/src/tools/git.rs` (read-only git)
- Test: `crates/guild-core/tests/tools.rs`

**Interfaces:**
- Produces:
  - `tools::Tool` (async_trait): `fn spec(&self) -> ToolSpec; fn default_policy(&self) -> Approval; async fn run(&self, workdir: &Path, args: Value) -> Result<ToolOutcome, ToolFailure>`
  - `tools::Approval { Allow, Ask, Never }`
  - `tools::ToolOutcome { output_for_model: String, ui_summary: Option<String>, diff: Option<String> }`
  - `tools::ToolRegistry` — name→boxed Tool, iteration for `Vec<ToolSpec>`
  - Built-ins: `read_file{path}`, `write_file{path,content}` (ui diff = unified diff old→new), `edit_file{path,old,new}` (fail with model-readable message if `old` not found or not unique), `glob{pattern}`, `grep{pattern,path_hint?}` (gitignore-aware via `ignore` crate), `run_command{command,cwd?,timeout_ms?}` (default 30s cap 300s; captures stdout/stderr; default policy Ask), `git{subcommand in [status,diff,log,branch]}` (read-only; default Allow).
  - Path scoping: all fs tools resolve relative paths under `workdir` and reject escapes (canonicalize check); run_command defaults cwd=workdir, rejects absolute cwd outside workdir.
  - Input validation via `jsonschema` against each tool's schema; failures return `ToolFailure::InvalidInput(model-readable)`.

- [x] **Step 1: Failing tests** — per tool: happy path, escape rejection (`../`), edit_file uniqueness error text, command timeout, grep with .gitignore respected, schema validation failure text.
- [x] **Step 2: FAIL.**
- [x] **Step 3: Implement.**
- [x] **Step 4: PASS + clippy.**
- [x] **Step 5: Commit** — `feat(core): built-in tools with scoping and approval defaults`

### Task 5: guild-core — agent loop with approvals

**Files:**
- Create: `crates/guild-core/src/agent/mod.rs` (loop), `crates/guild-core/src/agent/policy.rs`
- Test: `crates/guild-core/tests/agent_loop.rs`

**Interfaces:**
- Consumes: Task 2 providers, Task 4 tools.
- Produces:
  - `agent::AgentConfig { max_steps: usize /* default 25 */, system_prompt: Option<String> }`
  - `agent::AgentHooks` (async_trait, the event sink): `on_text(&self, &str)`, `on_tool_call(&self, &ToolCall)`, `on_tool_result(&self, &ToolCall, &ToolOutcome|ToolFailure)`, `request_approval(&self, &ToolCall) -> async ApprovalDecision` (`Approve`, `Deny { reason }`), `on_done(&self, summary)`
  - `agent::run_agent(&dyn ModelProvider-ish sender, tools: &ToolRegistry, policy: &ApprovalPolicy, messages: Vec<Message>, hooks: &dyn AgentHooks, cfg) -> Result<AgentResult>` — loop: stream model call (accumulate text + tool calls) → if tool calls: for each, resolve policy (policy.overrides(tool) or tool.default_policy()); Ask → hooks.request_approval (Deny feeds a tool message "denied by user: reason"); Never → skipped with message; run tool; append tool message(s) via provider-agnostic message list; continue until no tool calls or max_steps.
  - `policy::ApprovalPolicy { default: Approval, overrides: HashMap<String, Approval> }` with serde (session-persistable).
  - The message-array management (assistant tool_calls + tool results) mirrors provider wire shapes so the next iteration replays correctly through the gateway.

- [x] **Step 1: Failing test** — with a scripted fake provider stream (via a test `ModelProvider` impl or wiremock): prompt → tool call → tool result → second model call → text → done; assert hooks sequence, message replay shape, deny path ("denied by user"), max_steps stop.
- [x] **Step 2: FAIL.**
- [x] **Step 3: Implement.**
- [x] **Step 4: PASS + clippy.**
- [x] **Step 5: Commit** — `feat(core): agent loop with approval hooks`

### Task 6: app-server — agent session over JSON-RPC

**Files:**
- Create: `crates/app-server/src/agent_session.rs`
- Modify: `crates/app-server/src/jsonrpc_loop.rs`
- Test: `crates/app-server/tests/agent_rpc.rs`

**Interfaces:**
- Consumes: Tasks 1–5; guild-server `serve_full()`-style full stack with tools-enabled fake provider.
- Produces (protocol additions):
  - `agent.start { chat_id?, project_dir, prompt, model?, policy? }` → events `agent.text`, `agent.tool_call`, `agent.tool_result`, `agent.done` → response `{ chat_id, summary }`. Multiple prompts per session append to the same chat history (server-persisted).
  - `agent.approve { request_id, decision: "approve"|"deny", reason? }` → `{}` (unmatched request_id → error).
  - `agent.policy.set { tool, policy }` → `{}`; `agent.policy.get` → current policy JSON.
  - Approval flow: hooks.request_approval registers a pending oneshot keyed by request_id, emits `agent.approval_request { request_id, tool, arguments }`, awaits; `agent.approve` resolves it.
  - History continuity: session keeps full message list client-side (server persists per-call); each `agent.start` with existing chat_id resumes from server history (GET messages) plus local tool-state.

- [x] **Step 1: Failing test** — full stack (testcontainer server + wiremock provider with a scripted tool-call stream + a scratch git repo as project_dir): `agent.start` → events arrive (text, approval_request, tool_result, done); `agent.approve` denies a `run_command` and the tool result says denied; second `agent.start` continues the same chat.
- [x] **Step 2: FAIL.**
- [x] **Step 3: Implement.**
- [x] **Step 4: PASS + clippy.**
- [x] **Step 5: Commit** — `feat(app-server): agent session over jsonrpc with approvals`

### Task 7: app-server — MCP clients and skills loading

**Files:**
- Create: `crates/app-server/src/mcp.rs`, `crates/app-server/src/skills.rs`
- Modify: `crates/app-server/src/agent_session.rs`
- Test: `crates/app-server/tests/mcp_skills.rs`

**Interfaces:**
- Consumes: `rmcp` client (transport: child process stdio; streamable HTTP), Task 4 registry.
- Produces:
  - `mcp::load_servers(project_dir) -> Vec<McpServerConfig>` — reads `{project}/.guild/mcp.json` (and `~/.guild/mcp.json` merged): `{ "servers": { "name": { "command": [..], "args": [], "url": "..." } } }`.
  - `mcp::connect_all(cfgs) -> Vec<(name, McpHandle)>`; `McpHandle::tools() -> Vec<ToolSpec>`, `McpHandle::call(name, args) -> Result<String>`; wrapped as `tools::Tool` impls (default policy Ask; remote HTTP servers policy via config).
  - `skills::discover(project_dir, config_dir) -> Vec<SkillEntry { name, path, description }>` — scans `{project}/.guild/skills/*/SKILL.md` and `{config}/guild/skills/*/SKILL.md`; frontmatter `name` + `description`.
  - System prompt includes a skills index: "available skills: name — description (path)"; agent reads full SKILL.md via read_file when relevant.
  - `agent.start` merges: built-ins + MCP tools + skill index in system prompt.
  - Test MCP server: a tiny bundled fixture script (python3 or shell) speaking MCP stdio for tests; rmcp test harness if available.

- [x] **Step 1: Failing tests** — mcp.json discovery merge; skill discovery with frontmatter parsing; (integration) fixture MCP server exposes `echo` tool, agent session lists it and can call it through a scripted provider flow.
- [x] **Step 2: FAIL.**
- [x] **Step 3: Implement.**
- [x] **Step 4: PASS + clippy.**
- [x] **Step 5: Commit** — `feat(app-server): mcp clients and local skills loading`

### Task 8: desktop — agent UI

**Files:**
- Modify: `apps/desktop/src/App.tsx`, add `src/views/AgentView.tsx`, `src/components/diff.tsx`, `src/components/approval.tsx`
- Modify: `apps/desktop/src-tauri/src/lib.rs` — add `pick_directory` via `tauri-plugin-dialog`
- Test: build passes; interactive check under xvfb (window + engine spawn); full human pass deferred to reviewer

**Interfaces:**
- Consumes: Task 6 protocol.
- Produces: Project picker (dialog) → AgentView: transcript with text/tool-call/tool-result blocks, approval modal on `agent.approval_request` (Approve/Deny+reason → `agent.approve`), policy toggles per tool (always/ask/never), model input, "New session" (new chat_id).

- [x] **Step 1: Wire tauri-plugin-dialog** (Cargo + capability `dialog:default`).
- [x] **Step 2: AgentView** with event-driven transcript rendering + approval modal.
- [x] **Step 3: Build green** (`npm run build`, `cargo clippy -p guild-desktop -- -D warnings`).
- [x] **Step 4: xvfb launch check** — window opens, engine spawns, no console errors in log.
- [x] **Step 5: Commit** — `feat(desktop): agent view with approvals and tool transcript`

## Self-Review

- **Spec coverage (M2):** agent loop (T5), built-in tools (T4), approvals (T5/T6 policy + UI T8), MCP clients (T7), local skills (T7), gateway tool-calling (T1–T3), desktop UI (T8). Registry install of skills is M3; only local-dir loading here, per spec §3.2.
- **Placeholders:** none; every task names exact types and test assertions.
- **Type consistency:** `ToolCall`/`ToolSpec`/`StreamEvent::ToolCall*` defined once in protocol (T1) and consumed unchanged downstream; `Approval` enum shared between tools (T4) and policy (T5); `request_id` string keys approvals across T6 events and method.
