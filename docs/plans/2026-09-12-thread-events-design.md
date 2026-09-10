# Thread event log + thinking + tool presentation + superproxy fetch — design spec

Date: 2026-09-12. Status: approved (maintainer). This file is the implementation
contract; the study backing it is `docs/deepseek-harness-study.md`.

Decisions locked by maintainer:

- Full event log: new `thread_events` table (type + JSONB payload), message
  history becomes a derivation. **No data preservation — drop the old
  `messages` data.**
- Reasoning blocks are NEVER dropped from context; they are resent to the
  model (`reasoning_content`, dsh rule) on every reasoning-carrying turn.
- Tool calls get collapsible frames + per-tool widgets driven by persisted
  `meta` (dsh presentationMeta pattern).
- Superproxy fetch integration under the existing plugin-based integration
  pattern; integrations gain categories: `search` provider, `fetch` provider.

## A. Thread event log

### A.1 Migration `0020_thread_events.sql`

```sql
DROP TABLE IF EXISTS messages;

CREATE TABLE thread_events (
  id UUID PRIMARY KEY,               -- uuid v7, generated at insert
  chat_id UUID NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
  seq BIGSERIAL UNIQUE,              -- global write order
  type TEXT NOT NULL,
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX thread_events_chat_idx ON thread_events (chat_id, id);
```

Chats table stays as-is. Existing chats become empty threads (accepted).

### A.2 Event vocabulary (v1)

Rust shape lives in `crates/protocol/src/api.rs`:

```rust
#[derive(Serialize, Deserialize, ...)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ThreadEvent {
    UserMessage   { content: String },
    SystemMessage { content: String },            // server-owned prompt, log-only
    AssistantMessage {
        turn: u32, step: u32,
        blocks: Vec<Block>,                       // stream order
        usage: UsagePayload,                      // tokens_in/out, cost_usd
        model: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        interrupted: Option<()>,                  // aborted turn prefix
    },
    ToolResult {
        turn: u32, step: u32,
        call_id: String, name: String,
        content: String,                          // model-facing text
        #[serde(default, skip_serializing_if = "is_false")]
        is_error: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        meta: Option<serde_json::Value>,          // widget payload, tool-owned
    },
    Compaction { summary: String },               // reserved, not built yet
}

#[serde(tag = "type", rename_all = "snake_case")]
pub enum Block {
    Text      { text: String },
    Reasoning { text: String },
    ToolCall  { id: String, name: String, arguments: String }, // raw, unparsed
}
```

`ToolCall.arguments` stays a **raw JSON string exactly as the model produced
it** (dsh rule) — never parse/reserialize on the persist path.

Not modeled: turn/step bracket events. `turn`/`step` ride on
assistant/tool events (turn = one client request; step = one model call +
its tool executions; Guild's existing `CHAT_MAX_STEPS` loop defines steps).

### A.3 Storage API — `crates/server/src/store/thread.rs`

- `append_event(chat_id, event: &ThreadEvent) -> Result<ThreadEventRow>` —
  assigns uuid v7 id; `seq` from BIGSERIAL; returns the row.
- `list_events(org_id, chat_id) -> Result<Vec<ThreadEventRow>>` — ordered by
  `id` (uuid v7), org-scoped join on chats.
- `ThreadEventRow { id, chat_id, seq: i64, event: ThreadEvent, created_at }`.
- DELETE the old `store/chats.rs` message functions
  (`append_message`, `list_messages`, `MessageRowDb`, the `MessageRow`
  conversion). `create_chat`, `list_chats`, `get_chat`, `set_machine` stay.

### A.4 Derivation rules

- **Model-facing history** (`build_model_history(events) -> Vec<Message>` in
  `worker/restate.rs`): user/message → `role:user`; assistant blocks →
  `role:assistant` with `content` = concatenated text blocks,
  `tool_calls` = the block's tool_calls, plus `reasoning` carried separately
  (see B.4); tool/result → `role:tool` with `tool_call_id`.
- **Thread projection** for the client: events as stored, ordered by id.
  The client derives display blocks itself (see D).

## B. Thinking end-to-end

### B.1 Provider layer — `crates/guild-core/src/provider/`

```rust
pub enum ProviderChunk {
    Text(ChatChunk),
    Thinking(ChatChunk),          // NEW: ChatChunk { text_delta, tokens_* }
    ToolCallDelta { ... },        // unchanged
    ToolCallDone { call },        // unchanged
}
```

- `openai.rs` `parse_frame`: parse `choices[0].delta.reasoning_content` into
  `ProviderChunk::Thinking { text_delta }` (accumulate empty-safe: skip empty
  deltas like text). Usage `completion_tokens_details.reasoning_tokens` may
  fill `tokens_out` only if simple; do not overreach.
- `openai.rs` request serialization: for assistant history messages carrying
  reasoning, add `reasoning_content` field = concatenated reasoning text of
  that message (dsh `serializeAssistant` rule: include on EVERY
  reasoning-carrying turn; empty-string content stays `""`, never null).
  `Message` type gains `reasoning: Option<String>` (protocol crate — add in
  B.2 so both workers compile against one shape).
- `anthropic.rs`: parse `content_block_delta` with
  `delta.type == "thinking_delta"` → Thinking chunk; when the route enables
  reasoning, send `thinking: { type: "enabled", budget_tokens }` (pick
  budget from a constant 8192, clamp to max_tokens headroom) and replay
  thinking blocks with signature `""` if the API requires; if signature
  handling proves nontrivial, replay reasoning as plain `reasoning_content`-
  style is WRONG for anthropic — instead replay as assistant text prefixed
  nothing, i.e. drop for anthropic routes but keep persisted. Document the
  limitation in a code comment. (Guild's pool is DeepSeek-routed; anthropic
  is secondary.)

### B.2 Protocol — `crates/protocol/src/`

- `Message { role, content, tool_calls, tool_call_id, reasoning: Option<String> }`
  (serde default None, skip if none; ts export).
- `StreamEvent::ThinkingDelta { content: String }` frame (matches `Delta`).
- `ThreadEvent`, `Block`, `UsagePayload` as in A.2. ts_rs exports for all.

### B.3 Model registry — reasoning flag

`registry.rs` / admin model config gains optional `reasoning: bool`
(default false). When true: the gateway request enables thinking for that
route (openai-shape: rely on model defaults + pass nothing extra unless
registry later adds effort; anthropic-shape: thinking budget per B.1) and
the client system prompt may mention nothing new. Keep the flag plumbed:
`ModelRoute { ..., reasoning: bool }`.

### B.4 ChatRunner loop — `crates/server/src/worker/restate.rs`

Turn start (on generate invocation):
1. Append `system/message` event with the built prompt (once per turn).
2. Append `user/message` event with the request content (unless a client
   message event was already appended by the gateway — choose: gateway HTTP
   handler does NOT write events; the journaled generate step writes them,
   so attach/replay stays consistent).

Per step, inside the streaming loop:
- Accumulate `reasoning` text alongside `text`; forward
  `StreamEvent::ThinkingDelta` frames to the broadcast `tx` as they arrive.
- ToolCallDone → blocks.
- On completion: persist ONE `assistant/message` event with blocks in order
  `[reasoning?, text?, tool_call*]` (skip empty blocks), usage, model,
  turn/step. This replaces the current `append_message` assistant write.
- Reasoning replay: `messages` Vec for the NEXT model call gets
  `reasoning: Some(...)` on the assistant Message (and derivation from
  stored events sets it for later turns) → openai.rs serializes it as
  `reasoning_content`. NEVER dropped.
- Tool execution unchanged (client/server paths), but the persisted
  tool/result event carries `meta` (see C.2) and the `turn/step` values.
- Aborted turn mid-stream: persist the prefix as `assistant/message` with
  `interrupted: true` (best effort in the abort path).

### B.5 Streaming to clients

Broadcast channel carries the new `ThinkingDelta` frame; the attach catch-up
snapshot sends the in-flight reasoning buffer just like the text buffer
(full buffer on first frame — add a `ThinkingSnapshot`? NO: keep it simple —
the catch-up `Delta` frame carries the full text buffer; add the same for
thinking: first `thinking_delta` frame after attach carries the full buffer).
Desktop/webui handle `thinking_delta` by updating/creating the current
reasoning block.

## C. Tool presentation

### C.1 Server: integration contract change — `crates/server/src/integrations.rs`

```rust
pub enum Category { Search, Fetch, Other }

pub trait Integration: Send + Sync {
    fn name(&self) -> &'static str;
    fn category(&self) -> Category;                    // NEW
    fn tools(&self, config: &Value) -> anyhow::Result<Vec<ToolSpec>>;
    fn execute<'a>(&'a self, config: &'a Value, tool: &'a str, args: Value)
        -> BoxFuture<'a, Result<ToolOutcome, String>>; // CHANGED
}

pub struct ToolOutcome {
    pub content: String,              // model-facing text (unchanged content)
    pub meta: Option<serde_json::Value>,   // widget payload
}
```

`server_tool_step` in restate.rs forwards `meta` into the `tool/result`
event. Model-facing contract unchanged (it sees `content` only).

### C.2 Widget meta shapes (persisted, replay-safe)

- `web_search` → `{ "card": "web", "kind": "search", "sources": [{url,
  title?, snippet?}], "truncated": bool }` (dsh WebSearchResultView shape).
- `web_fetch` → `{ "card": "web", "kind": "fetch", "url": String,
  "status_code": u16, "truncated": bool, "title"?: String }`.
- Client tools (desktop executor): the desktop runner posts results with
  meta when cheap:
  - `bash` → `{ "card": "terminal", "output": "...", "exit_code": n }`
  - `read` → `{ "card": "read", "path": "...", "offset": n, "total_lines": n,
    "lang"?: "..." }` (lines themselves are in content; do not duplicate)
  - `edit`/`write` → `{ "card": "diff", "path": "..." }`
- Client→server result RPC (`tool result` gateway call) gains optional
  `meta` field, stored verbatim on the event.

### C.3 UI (desktop WebChat — apps/desktop/src/views/WebChat.tsx)

Thread rebuild from `GET /api/v1/chats/{id}/thread` (see E). Rendering rules:

- `user/message` → user bubble.
- `assistant/message` → render blocks in order:
  - `reasoning` block → collapsible "Thinking" frame, header shows
    "Thought" + duration when derivable; body = text; default collapsed.
  - `text` → markdown as today.
  - `tool_call` → collapsible tool frame (header: icon by kind, tool name,
    human title from widget, status pill done/running/error).
- `tool/result` → fills the matching tool frame body via widget:
  - `card: web, kind: search` → citation list (linked title + snippet).
  - `card: web, kind: fetch` → page card (url, status pill, truncated badge,
    markdown excerpt of content).
  - `card: terminal` → terminal card (output + exit pill).
  - `card: read` → line-numbered view from content.
  - `card: diff` → simple unified diff rendering of content (or meta.path
    header + content).
  - fallback → pretty JSON.
- Live streaming: `thinking_delta` → create/update current reasoning block;
  `tool_started`/`tool_completed` frames keep working as today but the
  resulting frames are the same collapsible widgets; on `done` the client
  re-syncs from the thread endpoint (it already reloads on idle).

### C.4 Admin UI — integrations section (apps/webui)

The admin console has no integrations UI today (API only). Add an
"Integrations" card to the admin area (Users.tsx-adjacent view or section on
Dashboard): list `GET /api/v1/admin/integrations` (now including
`category`), enable/disable toggle + config JSON editor + save per row,
grouped by category (Search providers, Fetch providers). New `superproxy`
kind appears in `available`.

## D. Superproxy integration — `crates/server/src/integrations.rs`

```rust
pub mod superproxy_plugin {
    // name: "superproxy", category: Fetch
    // config: { "base_url": "http://host:15505", "token"?: "..." }
    // tools: web_fetch
}
```

- `web_fetch` ToolSpec: `{ url: string, max_chars?: number }`.
- Execute: `GET {base_url}/v1/fetch?url=<url>&format=markdown` (superproxy
  gateway; SSRF-screened, cached, returns `{url, status, title, description,
  published, wordCount, content}` — content is markdown). Optional token →
  `Authorization: Bearer` header (future-proof; gateway accepts today).
- Model-facing content: title header + markdown body, truncated to
  `max_chars` (default 8000) with a `[truncated]` note.
- meta: `{ "card": "web", "kind": "fetch", "url": final_url,
  "status_code": status, "truncated": <content was cut>, "title": title? }`.
- Errors → `Err(String)` (model sees a tool error; is_error path).
- searxng plugin: add `category() -> Search`; keep behavior, no meta yet
  (optional: add web/search meta with sources — cheap, do it: parse the
  returned text? NO — restructure searxng execute to build meta from the
  JSON it already parses: sources list from results).

## E. HTTP API

- NEW `GET /api/v1/chats/{id}/thread` → `{ "events": [ThreadEventRow...] }`
  (row includes id/seq/created_at + payload). Auth: org member, same as
  messages today.
- REMOVE `GET/POST /api/v1/chats/{id}/messages` (chats.rs `messages` +
  `append` handlers). Clients move to /thread; nothing else reads messages.
- Admin `GET /api/v1/admin/integrations`: `available` entries gain
  `"category": "search"|"fetch"|"other"`; stored rows pass through (add
  category in the response by looking up the plugin).
- Gateway streaming + attach: add `thinking_delta` frame type (protocol
  serde snake_case).

## F. Verification

- Fast suite: `cargo nextest run -p guild-server --features test-support`
  green; new tests:
  - thread store: append/list roundtrip, org scoping.
  - derivation: events → model history incl. reasoning replay.
  - openai parse: reasoning_content delta → Thinking chunk; serialize:
    assistant reasoning → reasoning_content field.
  - superproxy: mock gateway (wiremock) → web_fetch tool outcome + meta;
    searxng meta.
  - chats API: /thread returns events; /messages gone (404).
- Desktop: `npx tsc --noEmit` + `npx vite build` clean in apps/desktop and
  apps/webui.
- Deploy: rebuild server image, restart, live check (curl /thread on a new
  chat, streaming with reasoning on a DeepSeek route if configured).

## G. Out of scope (this milestone)

Compaction implementation, branching/tree semantics, approval-as-event
(Phase 2 stays as planned), anthropic thinking signatures beyond basic.
