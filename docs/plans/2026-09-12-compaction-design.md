# Compaction — design spec (phase 3)

Date: 2026-09-12. Status: approved (maintainer: "first compaction … then desktop
release"). Builds directly on the thread event log
(docs/plans/2026-09-12-thread-events-design.md §A.2: `Compaction { summary }`
reserved type) and the dsh compaction seam (retainedTail checkpoint pattern).

## Goal

Long threads can be compacted on demand: the conversation up to the
compaction point is summarized by the model into one durable `compaction`
thread event; model-facing history derivation replaces everything before the
event with the summary (plus a small verbatim tail). The thread log itself is
never rewritten — compaction is a derivation change, exactly like dsh.

## A. Protocol (`crates/protocol/src/api.rs`)

Widen the reserved variant:

```rust
Compaction {
    summary: String,
    /// Total tokens the pre-compaction history represented (informational).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    tokens_before: Option<u32>,
    /// How many message-bearing events immediately BEFORE the compaction
    /// event stay in context verbatim (the dsh retained tail).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    keep_last: Option<u32>,
    /// Model + usage of the summarization call.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    model: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    usage: Option<UsagePayload>,
},
```

(ts export + protocol tests; ts bindings regenerated.)

## B. Derivation (`worker/restate.rs` `build_model_history`)

When the walker hits a `Compaction` event:
1. Emit a user-role message: `"[Conversation summary so far]\n\n{summary}"`.
2. Then re-emit the LAST `keep_last.unwrap_or(4)` message-bearing events that
   came BEFORE the compaction event (user/assistant/tool only, in order —
   scan the already-built `out` vec; skip events already folded into the
   summary).
3. Then continue with events AFTER the compaction event as normal.
Multiple compactions: each one applies at its position (summary of
everything before it, tail per its keep_last). Implementation shape: two
passes — collect events into a Vec, find compaction indices, build per
segment. Keep the existing per-event behavior for events after the last
compaction.

Model-facing derivation TESTS: compaction splits history correctly; events
after it flow; tail count honored; multiple compactions compose.

## C. ChatRunner `compact` handler (Restate virtual object)

`pub async fn compact(ctx, state, req: CompactReq { org_id, chat_id })`:

- Virtual-object serialization guarantees compact and generate never run
  concurrently for the same chat. If a generation IS somehow in flight
  (generations map), reject with a terminal error.
- Journaled: load thread events; derive the model-facing history (the FULL
  history, pre-compaction — the thing being summarized). If there are fewer
  than 4 message-bearing events, terminal error "thread too short to
  compact".
- Model selection: the model of the latest assistant_message event
  (payload.model), falling back to the org's first enabled route. Resolve
  the route + quota like generate does (journaled).
- Journaled: one non-streaming model call with a compaction prompt:
  "Summarize this conversation for continuation by a coding agent. Capture:
  the user's goals and decisions, key facts and artifacts (paths, versions,
  identifiers), open questions, and the current state / next step. Be
  factual and compact. Do not answer as if replying to the user." — send
  via the provider (accumulate the stream; no client streaming needed).
- Journaled: append the `Compaction` event with summary, tokens_before =
  usage.tokens_in of the summarization call (informational), keep_last = 4,
  model, usage. Broadcast a `StreamEvent::Done`-shaped frame? NO — instead
  broadcast `StreamEvent::ApprovalResolved`-style new frame is NOT wanted;
  clients poll GET /thread (see F). Broadcast nothing.
- Clear nothing else; the next `generate` derives through the compaction.

## D. HTTP

`POST /api/v1/gateway/chat/{id}/compact` (org-scoped, like chat):
`restate_send_one_way` ChatRunner/{chat}/compact. Returns `{ok: true}` —
the client polls the thread log for the compaction event (fire-and-forget
semantics like generate).

## E. UI (apps/desktop WebChat)

- Thread header: a "Compact" action (icon button, tooltip "Summarize this
  thread to shrink context"; disabled while a generation is running).
- On click: POST compact, show a transient "Compacting…" chip, then poll
  GET /thread every 3 s (up to 60 s) until a compaction event with
  `seq > lastKnownSeq` appears; reload blocks; chip clears.
- Thread rendering: a compaction event renders as a collapsed system-style
  card: "Thread compacted — summary (expandable)". Expanding shows the
  summary text. Always collapsed by default.

## F. Tests

- Derivation: compaction split, tail count, post-compaction events, multiple
  compactions, usage/model fields roundtrip.
- Worker: compact handler happy path against a mocked provider
  (wiremock pattern exists from A-tests) — summary event appended with
  model/usage; too-short thread rejected; generation-in-flight rejected.
- HTTP: compact endpoint org-scoping.

## G. Ship

Suite green, tsc/vite clean, deploy, live browser test: open the search
thread, click Compact, verify the card + that a follow-up question still
works with the summary in context (the model can answer "what did we do so
far?" from the summary). THEN desktop release 0.3.9 (separate task: bump
`tauri.conf.json` to 0.3.9, `scripts/release-desktop.sh`, sha256 verify on
upload, updater delivers once).
