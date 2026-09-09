# Milestone 6 — Execution backends & public OpenAI-compatible endpoint

Status: COMPLETE

(All 4 tasks done on feat/milestone-6. Compose E2E verified: api-key issued →
/openai/v1 non-stream + stream calls; workspace agent session turn executed
write_file server-side (file present in /data/workspaces/<org>/... inside the
container), history + usage persisted. Note: provider base_url must NOT include
/v1 (the OpenAI adapter appends it); the fake provider must emit SSE frames
with "data: " prefixes.) (branch `feat/milestone-6`, built on `feat/milestone-5`)

Spec §10.6: "Execution backends — server-side sandboxed repo execution as an
additional backend; public OpenAI-compatible gateway endpoint."

## Context

- The gateway (internal) already streams OpenAI/Anthropic-shaped calls with
  tool pass-through; usage events land in ClickHouse per request.
- guild-core's agent loop + tools are reusable server-side (used by the M5
  routine worker over the internal completion API).
- The web UI only uses the internal gateway; a public surface is now added.

## Task 1 — API keys for the public endpoint

- Migration `0008_api_keys.sql`: `api_keys` (id uuid v7, org_id, created_by,
  key_hash (argon2 or sha256+salt — use argon2 like passwords? cheap constant
  compare is fine: store sha256 hex of the token), name, prefix (first 12
  chars for display), created_at, revoked_at).
- Store: `api_keys.rs` (create → returns plaintext `gk_<32 hex>` once; find by
  hash for auth; list; revoke).
- Admin API: `POST /api/v1/admin/api-keys` (returns plaintext once),
  `GET /api/v1/admin/api-keys`, `DELETE /api/v1/admin/api-keys/{id}`.
- Extractor `ApiKeyUser` (org_id + user_id, resolved by bearer token).
- Tests: issue → use → revoke → 401.

## Task 2 — Public OpenAI-compatible endpoint

- `POST /openai/v1/chat/completions` (API-key bearer auth).
- Accepts the OpenAI Chat Completions shape: `model`, `messages` (string or
  content-array parts), `stream` (bool), `tools` (optional), `max_tokens` ignored.
- Maps messages → internal gateway flow (no chat persistence; usage attributed
  to the key's org/user with session_id = key id).
- `stream: false` (default): accumulate provider stream → one JSON response in
  OpenAI format (`choices[0].message`, `usage`).
- `stream: true`: SSE in OpenAI chunk format
  (`data: {"choices":[{"delta":{...}}]}` … `data: [DONE]`), tool calls as
  `delta.tool_calls` fragments.
- Errors keep the Guild JSON envelope for non-OpenAI-path errors; for this
  endpoint return OpenAI-style error `{"error":{"message","type"}}`.
- Tests: scripted provider; stream and non-stream; tool-call passthrough; usage
  rows recorded; revoked key → 401.

## Task 3 — Server-side execution backend (workspace agent sessions)

- The server runs guild-core's agent loop against an org workspace directory
  (`{GUILD_DATA_DIR}/workspaces/{org_id}/{name}/`), tools: read_file,
  write_file, edit_file, glob, grep, run_command (gated: default Never,
  enabled with `GUILD_ALLOW_SHELL_TOOLS=1`), git (read-only). Path scoping via
  existing `resolve_scoped`.
- Migration `0009_agent_sessions.sql`: `agent_sessions` (id, org_id, user_id,
  workspace_name, created_at) — history reuses the `chats` tables (session ==
  chat row; messages persisted server-side with tool columns).
- API (session-token auth):
  - `POST /api/v1/agents/sessions` {workspace_name} → creates dir + row +
    chat; 409 on name collision within org.
  - `POST /api/v1/agents/sessions/{id}/turns` {message} → SSE of the agent
    loop (delta / tool_call_done / tool_result / done frames); persists
    messages + tool results as it goes; usage recorded per model call.
  - `GET /api/v1/agents/sessions` → list; `GET /api/v1/agents/sessions/{id}`
    → messages history.
- Approval policy server-side: Allow for read-only, Ask-as-Allow for
  write/edit (server-managed), Never for run_command unless flag.
- Model routing: same gateway routes (org model → provider).
- Tests: full_state + scripted provider; turn creates files in the workspace;
  history persisted; run_command refused by default; usage recorded.

## Task 4 — Compose smoke E2E + docs

- compose unchanged (server already role=all); README section for the public
  endpoint + api keys + workspace sessions.
- Smoke: issue api key → non-stream + stream call via :18080/openai/v1 →
  create agent session → run a turn that writes a file → verify file in
  container + history via API.

## Verification

- `cargo test --workspace`; `cargo test -p guild-server --features test-support`
- `cargo clippy --workspace --all-targets -- -D warnings`
- Compose smoke on 18080/19071, then teardown.
