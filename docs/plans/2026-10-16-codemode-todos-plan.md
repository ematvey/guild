# Codemode todos — implementation plan (from TODO.md)

Source: `TODO.md` § "Codemode: history access + presentation" (4 items).
Everything here lands on **develop**; the only desktop-release milestone is (4).

## Current seams (verified)

- Codemode wiring: `apps/server/src/harness/runtime.ts` — `createCodemodeExtension`
  at L284 (`models: false`, QuickJS sandbox), `baseConfiguration()` L290, and
  `provisionTurnTools()` L798 which `conversation.configure()`s
  `{ extensions, tools }` per turn (integrations + user MCP runtimes add theirs).
- pi-durable configure accepts **`modelTools: { remove? , add? }`** — the filter
  that decides what the *model* sees, separate from the *registry* (what exists
  and what codemode scripts / nested calls can reach). Codemode's prompt section
  renders from registry tools (`describe.d.ts`: "renders from the conversation's
  callable tools"), grouped by `CodemodeNamespace` prefixes.
- Nested calls (a script's `tools.*`) produce **no transcript cards**
  (`apps/server/src/chats/bridge.ts` L304: `tool_execution_start` with
  `parentToolCallId !== undefined` returns early). The owning codemode call's
  result `details` carries `calls: CodemodeNestedCall[]` — name, args, status —
  which is the data source for desktop rendering of nested activity.
- Desktop tool frames: `apps/desktop/src/views/WebChat.tsx` `ToolFrame` L1382+;
  no syntax highlighter in the client (react-markdown + remark-gfm only).
- Thread storage/permissions: org-scoped (`user.org_id`); `GET /api/v1/chats/{id}/thread`
  (`apps/server/src/platform/http/chats.ts` L108) is the per-thread read path;
  the chat-list query (`threadList`, org + user scope) is the permission
  reference for cross-thread search.

## Milestone 1 — codemode-only tool exposure (todo 1)

Goal: the model sees only `codemode`; every other tool stays registered and
script-reachable but is not declared as an active tool.

- In `runtime.ts`: extend the configure payload in `provisionTurnTools()` (and
  the bootstrap `conversation.configure` if it declares tools) with
  `modelTools: { remove: <all registered tools except codemode> }`.
  - Simplest correct form: after building the full tools array, filter it for
    the removal list — `tools.filter(t => t.name !== "codemode")`.
  - Verify against pi-durable semantics: `modelTools.remove` takes
    registrations; confirm removal is by name or by instance when implementing.
- **Verify nested access survives the filter** (the load-bearing assumption):
  scripts reach tools through the registry, and the codemode section renders
  from registry tools — write a test where a script calls a tool that is
  model-filtered away (e.g. nested `tools.bash`) and assert it still executes
  through the full pipeline (exec policy, approval gate). If pi-durable
  resolves script targets against `modelTools`, this milestone needs an
  upstream change instead — check before building anything else.
- Namespaces: register a `CodemodeNamespace` per tool family (bash/read →
  `tools.*` already implicit; integrations → their prefix; MCP → `mcp_…`) so
  the codemode section groups declarations within `DEFAULT_CODEMODE_INLINE_BUDGET`.
- Expected UI regression, accepted here and fixed in (4): per-tool cards
  disappear (nested calls make no cards); chats show one codemode card per
  script call until the widget upgrade lands.
- E2E: existing codemode round-trip test + a real-model turn on :18080 where
  the transcript shows exactly one declared tool (`codemode`).

## Milestone 2 — thread-history access inside codemode (todo 2)

Goal: scripts read the current thread's real history as structured JSON, not
from a local snapshot.

- New tools on the guild extension (server-side, org-scoped like every other
  route):
  - `thread_history(chatId implicit → the conversation's own chat, { role?,
    after?/before? cursors, text?, limit })` → `{ messages: [{ id, role, ts,
    text, toolCalls? }] }`.
  - Backing: the same storage `listEvents`/thread read uses; pass the chat id
    from harness context at tool definition time (runtime knows it).
- Tools carry `outputSchema` so scripts get JSON (`declarationOf` resolves
  tools without one to text output).
- Hide from the model: they join the `modelTools.remove` list from (1); they
  appear in the codemode section under a `thread.` namespace (add the prefix
  to the extension's namespace list).
- Tests: fixture thread (reuse `apps/server/src/test/fixtures/m3-threads.json`
  shape) → script filters by role + text, paginates; permission test: a script
  cannot read another org's chat (the tool takes no chatId argument — it is
  bound server-side, which makes cross-account leakage structurally
  impossible; assert that).

## Milestone 3 — global search across threads (todo 3)

Goal: text search across every thread the user can access.

- Server route `GET /api/v1/chats/search?q=…&limit=` — WHERE clause mirrors
  `threadList`'s org/user scoping exactly (never invent a second permission
  path). Postgres `ILIKE` + snippet via `ts_headline`-or-substring first cut;
  tsvector index only if ILIKE measurably hurts on real data.
- Expose to codemode as `thread_search({ query, limit })` (user bound
  server-side at tool creation, same as (2)) returning
  `{ threadId, chatTitle, messageId, snippet }[]` for drill-in with (2)'s
  cursors.
- Tests: multi-thread fixture, cross-org denial, empty-query behavior.

## Milestone 4 — codemode tool widget (todo 4, desktop release)

Goal: the codemode card renders like pi's: script source as a proper code
block; nested calls as a compact list with status.

- In `WebChat.tsx` `ToolFrame` (or a dedicated `CodemodeFrame` keyed off
  `t.name === "codemode"`):
  - Extract `t.input.code` (the script source) → render in a collapsed-by-default
    frame body as monospace block reusing the existing `[&_pre]`/`[&_code]`
    styling. No highlighter dependency in the first cut (optional follow-up:
    a tiny JS tokenizer; do not add shiki/prism weight for this).
  - Result `details.calls` (the `CodemodeNestedCall[]`): list rows
    `toolname(argPreview) → status pill`, same visual language as tool frames.
- Milestone ordering matters: ship (4) together with or after (1) — (1) alone
  degrades the chat UI's tool visibility.

## Rollout

- Server milestones (1–3): commit → `docker compose up -d --build server` in
  `deploy/compose` → verify on :18080 (codemode-only transcript, script
  history read).
- Milestone 4 needs a desktop client release (the only one in this plan):
  bump to 0.5.59 in the same task, `scripts/release-clients.sh` from
  current HEAD (lesson from 0.5.57: release artifacts must be built from a
  tree that contains the change).
