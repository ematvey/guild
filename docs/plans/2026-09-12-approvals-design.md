# Phase 2 — approvals as protocol events — design spec

Date: 2026-09-12. Status: approved (maintainer: "do phase 2 first, same full
scale comprehensive approach"). Groundwork: docs/plans/2026-09-12-thread-events-design.md
(thread event log is live), dsh study for the pre-execute waterfall pattern.

## Goal

Client-tool execution in the chat loop becomes gated by a server-side,
per-chat approval policy. When the policy says "ask", the workflow requests
approval as a durable protocol event, ALL attached clients see an approval
card, the first Approve/Deny wins, and the decision is recorded on the
thread. The policy is editable from any client.

## A. Per-chat approval policy (server-side setting)

Migration `0023_chat_approval.sql`:

```sql
ALTER TABLE chats ADD COLUMN IF NOT EXISTS approval JSONB;
```

- Semantics follow guild-core `ApprovalPolicy`: `{"default": "ask"|"allow"|"never",
  "overrides": {"read": "allow", ...}}`. NULL column = the server default.
- Server default policy (when column is NULL): default `ask`, overrides
  `{"read": "allow"}` — read-only tools flow, state-changing tools ask.
- Store: `chats.rs` — `get_chat`/`list_chats` return `approval: Option<Value>`;
  new `set_approval(org, chat, approval: Option<Value>)` (NULL clears → server
  default).
- HTTP: `GET/PUT /api/v1/chats/{id}/approval` (org-scoped; PUT body = the
  policy JSON or `{"approval": null}` to reset). Validate against
  ApprovalPolicy serde on save.
- The gate applies to CLIENT tools (read/bash/edit/write) in the ChatRunner.
  Server-side integration tools (web_search, web_fetch) are never gated.

## B. Protocol additions (crates/protocol)

```rust
// ThreadEvent gains two variants (log-only, like SystemMessage — excluded
// from model-facing history derivation):
ApprovalRequest {
    call_id: String, name: String, arguments: String,
}
ApprovalDecision {
    call_id: String,
    approved: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    reason: Option<String>,      // e.g. "timed out", "denied by user"
}

// StreamEvent gains:
ApprovalRequested { call_id: String, name: String, arguments: String },
ApprovalResolved  { call_id: String, approved: bool,
                    #[serde(default, skip_serializing_if = "Option::is_none")]
                    reason: Option<String> },
```

## C. Worker: the approval gate (crates/server/src/worker/restate.rs)

In `client_tool_step`, AFTER the machine-online check and BEFORE suspending
for execution:

1. Resolve the effective policy (journaled ctx.run snapshot): chat's stored
   policy (or server default) via `policy_for(chat)` →
   `guild_core::agent::policy::ApprovalPolicy::for_tool(name, Ask)`.
   - Allow → proceed unchanged.
   - Never → return denied ToolResultPayload ("denied by policy", is_error)
     — no approval events, straight to the tool-result append.
   - Ask → the gate (below).
2. The gate:
   - Journaled: append `ApprovalRequest` thread event.
   - Journaled: broadcast `StreamEvent::ApprovalRequested`.
   - Awakeable (`approval:{call_id}` state key, mirror `state_key`), plus
     `send_after(APPROVAL_TIMEOUT = 5 min)` targeting the shared
     `complete_approval` handler with `{call_id, approved: false, reason:
     "timed out awaiting approval"}`.
   - Await the promise → decision.
   - Journaled: append `ApprovalDecision` event + broadcast
     `ApprovalResolved`.
   - Denied → return ToolResultPayload "denied by user: {reason}" (is_error).
   - Approved → continue into the existing ToolStarted/suspend flow
     unchanged.
3. Shared handler `complete_approval(ToolResultReq-ish {call_id, approved,
   reason})` on ChatRunner (mirror `complete_tool` exactly): resolve the
   awakeable via state key `approval:{call_id}` if present, clear the key,
   no-op when absent (first answer wins; late answers and replays no-op).

## D. HTTP

- `POST /api/v1/gateway/chat/{id}/approvals/{call_id}` body
  `{approved: bool, reason?: string}` → org-scoped chat check →
  `restate_send_one_way` ChatRunner/{chat}/complete_approval (mirror the
  tool_result handler).

## E. Attach replay

`attach_stream` already replays pending client tools (ToolStarted for
un-executed suspended calls). Mirror it: when attaching, scan the thread's
unresolved `ApprovalRequest` events (request without a matching decision,
and the tool not yet completed) and emit `ApprovalRequested` frames for
them, so a late-attaching client sees the pending card.

## F. UI (apps/desktop WebChat + settings)

- Approval card in the thread stream, rendered from the event pair:
  - Pending (request without decision): card with tool name, arguments
    preview, **Approve** / **Deny** buttons → POST the D. endpoint; disable
    buttons after clicking (optimistic) — the frame updates to resolved on
    the ApprovalResolved frame or on reload.
  - Decided: compact card "approved ✓" / "denied ✗ (reason)".
- Live frames wire the two new StreamEvent variants: ApprovalRequested
  inserts a pending card, ApprovalResolved updates it.
- Settings dialog: Approval section for the open chat — a default select
  (ask / allow / never / server default) + optional per-tool overrides JSON
  textarea (same shape as the admin integrations editor). GET/PUT the D.
  settings endpoints on open/save.
- Reuse the ToolFrame collapsible styling for approval cards.

## G. Engine path (app-server)

The engine's local loop already has ApprovalPolicy + a request_approval hook
(agent_session.rs) — unchanged. The chat-path gate is independent.

## H. Tests

- Policy resolution: NULL column → server default; override precedence.
- Worker gate: ask → approval events appended, promise resolved by the
  shared handler (approved + denied paths), timeout auto-deny, first-answer-
  wins dedupe.
- Derivation: approval events excluded from model history.
- HTTP: approvals endpoint org-scoping; settings GET/PUT roundtrip.

## I. Verification + ship

Suite green, tsc/vite clean, deploy, live browser test: chat in ask-mode →
bash tool → card appears → Approve → tool runs → result; Deny path; policy
switch to never/allow in settings.
