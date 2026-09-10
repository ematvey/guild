# DeepSeek Harness (dsh) — loop & persistence architecture study

Source: github.com/deepseek-ai/deepseek-harness @ 0.1.5-rc.2, clone at
`/tmp/deepseek-harness`. Read for the Guild thread-model redesign. Every claim
below points at a real file.

## 1. The thread is an append-only log of typed events

`packages/core/session/src/types.ts` + `docs/subsystems/session.md`:

> A `Session` is an **append-only log** of typed `SessionEvent`s — the single
> source of truth for an agent's whole interaction history. The LLM message
> history is *derived* from the log, never stored separately; replay is
> re-derivation from the same events.

Event vocabulary (`SessionEventMap`, merge-extensible — plugins add types):

- `turn/start` / `turn/end` — one user-request cycle; `step/start` / `step/end`
  — **one model call plus the tool executions it requested**.
- `user/message` — human prompt or synthetic injected context (`source`
  distinguishes them).
- `system/message` — rendered system prompt, log-only, reconstructs request
  header.
- `assistant/message` — assembled per step: `message` (block array) + `usage`
  + `interrupted?: true` + **the exact timed model stream** (`stream`) —
  failures/aborts settle as visible-prefix messages, not fabrications.
- `assistant/attempt` — a failed/retried attempt that committed no surface
  message; stream preserved without entering model-visible history.
- `tool/call` — `{ callId, name, arguments: string }` — arguments kept **raw,
  unparsed**, exactly as the model produced them.
- `tool/result` — model-facing result + optional `error {name, code}` +
  optional **tool-private `meta` JSON** (see §4). Log-validated as JSON at
  append time.
- `request/header`, `request/context` — routing/route-capacity snapshots.
- `compaction/*` — added by the compaction *plugin* via declaration merging;
  not core.

Durability: `session-checkpoint-policy` makes model requests, top-level tool
side effects, and completed steps durable **before the next action**; JSONL
backend with immutable generation files + successor publication
(`session-persistence-jsonl`).

## 2. Message content = typed block arrays

`packages/llm/llm/src/types.ts`:

```ts
interface ContentBlockMap {
  'text':       { type: 'text'; text }
  'reasoning':  { type: 'reasoning'; text }        // first-class, top-level
  'image':      { type: 'image'; attachment }
  'file':       { type: 'file'; attachment }
  'tool-call':  { type: 'tool-call'; id; name; arguments: string }
  'tool-result':{ type: 'tool-result'; toolCallId; content: ContentBlock[]; isError? }
}
```

One assistant message carries its blocks **in stream order** — reasoning sits
inline before the tool calls it produced. Content maps are merge-extensible:
"New core blocks must land with adapter, UI, and compaction support."

## 3. Reasoning is never dropped — replayed natively per route

`packages/llm/llm-deepseek/src/serialize.ts` (`serializeAssistant`):

```ts
content: text,                 // "" — NEVER null; null bricks later turns (gateway 400)
...reasoning.length > 0 ? { reasoning_content: reasoning } : {},
...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
```

- CoT passback on **every** reasoning-carrying turn; official DeepSeek rule
  requires it on tool-call turns. A gateway re-encoding for another vendor
  recovers the upstream thinking signature by hashing this exact text.
- The harness stores reasoning as a `reasoning` block; the wire serializer
  decides per route how to replay it (`reasoning_content` native field for
  DeepSeek; pi-ai's OpenAI serializer additionally supports signed
  `reasoning_details` and a text-ified fallback).
- SSE side (`translate.ts`): `delta.reasoning_content` accumulates into a
  `reasoning` block and streams out as `reasoning-delta` events.

## 4. Tool rendering: declared render-intents, persisted, replay-safe

`packages/core/tools/src/presentation.ts` — the pattern to copy:

- A tool declares `presentCall(args) → ToolCallView` and
  `presentResult(args, result) → ToolResultView`. These are
  **provider-neutral render intents**, not UI code. UI bridges switch on
  `card` / `kind`; incapable UIs fall back to raw content.
- Call views: `generic` (title + `kind` icon vocabulary: read/edit/delete/
  move/search/execute/fetch/other + optional `rawInput` + `locations`),
  `terminal` (command + cwd), `diff` (FileDiff[]).
- Result views: `generic`, `terminal` (output + exitCode/signal pill),
  `diff`, `search` (matches-by-file or path list, `truncated`/`total`),
  `read` (line-numbered window, `lang`, `totalLines`), and **`web`**:
  - `WebSearchResultView { sources: WebSource[]; answer?; truncated }`
    (`WebSource { url; title?; snippet?; publishedAt? }`)
  - `WebFetchResultView { url; statusCode; truncated }`
- **Replay mechanism**: the structured data cannot be reconstructed from the
  model-facing text, so the tool projects it through
  `output.presentationMeta` → persisted on the durable `tool/result` event as
  tool-private `meta` → `presentResult` narrows it back on live **and replay**
  paths. Cards reproduce identically after restart. ("dsh-tool-fs carries its
  result-time contextual diff here" — same channel.)

## 5. Everything is a plugin

Capabilities register on the Cordis context (`ctx.tools`, `ctx.sessionPersistence`,
`ctx.sessionProjections`, …). Compaction is a plugin that adds event types.
The web search/fetch tools are ordinary tool plugins (`packages/web/tool-web`)
with their own presenters. Approval/pre-execute is an event waterfall
(`tools/pre-execute`), not a special case in the loop.

## Implications for Guild

1. Adopt an **append-only, typed event log** as the chat thread's source of
   truth; model-facing message history becomes a *derivation*. Guild's Restate
   ChatRunner already journals per step — the log maps 1:1 onto
   turn/step semantics.
2. Assistant turns = block arrays (`reasoning`/`text`/`tool_call`) in stream
   order; tool results are sibling rows with `meta JSONB`.
3. Thinking: stream as its own event kind, persist as a block, **resend as
   `reasoning_content` on every reasoning-carrying turn** (Guild's pool is
   DeepSeek-routed; native field, not text fallback).
4. Tool widgets: port the dsh render-intent vocabulary (card/kind + views)
   and persist per-tool `meta` on tool-result rows so widgets replay
   identically after refresh.
5. Superproxy fetch integration: a tool plugin contributing `web_fetch`
   (and optionally `web_search`) whose presenter emits
   `WebFetchResultView`-shaped meta; enabled per org like searxng, with a
   category field (search/fetch) on the integration registry.
