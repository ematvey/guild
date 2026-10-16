# Affected-feature browser verification and fixes — 0.5.74

The full browser pass follows the Pi Durable audit and conversation-lifetime
changes in 0.5.71–0.5.72. It uses isolated managed dev members and local MCP
and provider fixtures against the compose stack at localhost:18080. Real
GLM calls verify guide execution and sandbox file operations. Production
is excluded. Detailed screenshots, recordings, and state evidence are in
`/home/user/guild-audits/pi-durable-2026-10-17/browser/`.

## Browser findings and resulting behavior

1. MCP settings displayed obsolete generated tool names. Discovery/probe
   now returns `call_name` from the same domain helper used by runtime
   registration. The UI displays that value and describes enabled tools
   without teaching a wire-format recipe. Older discovery responses fall
   back to the remote tool name rather than inventing a call identity.
2. A successful no-op manual compaction left “Compacting thread…” forever.
   Starting compaction now returns its durable task ID; the authenticated,
   chat-scoped status route exposes running/completed/failed outcomes.
   A conversation-owned compaction returns a write submission, so status
   follows that submission through queued placement; a prepared summary is
   not a no-op. Cancelled or superseded writes report failure.
   The client follows that task, clears its own chat's indicator on every
   terminal outcome, and reports when no compaction was needed. Generation
   busy/idle transitions no longer stand in for compaction completion.
   A summary still arrives through ordinary durable transcript projection.
3. Worker-mode generation never sent transient output to the parent feed.
   An ordered IPC relay now carries open/event/dirty/close signals. Buffer
   patches mirror partial text and thinking for reconnect/sync without
   repeatedly copying the full growing response. Buffers belong to each
   worker handle and are discarded on exit; events from superseded handles
   are ignored. Durable transcript and approval records remain in Postgres.

4. Testing a new MCP connection silently saved and enabled the server before
   Add, so closing the dialog retained it and post-probe edits could be lost.
   A validated, authenticated draft-probe endpoint now performs discovery
   without persistence. Only Add writes the current draft. Saving edited
   server settings invalidates old probe results and tool counts.

## Contract checks

The worker regression requires a live partial before the final assistant
entry exists, matches its generation ID to the acknowledgement, syncs the
socket during the run, and verifies partial restoration and terminal buffer
cleanup. Compaction checks cover a real no-op task, cross-chat task-ID
rejection, authentication, and malformed IDs. Reducer checks ensure a task
outcome clears a no-op indicator and another chat cannot clear the current
one. MCP probe and list responses must agree on canonical call names.

## Browser coverage and delivery

In progress. Completion requires the final suite, dev compose/client release,
and live verification of all three fixes. The external report tracks the
full matrix; it does not count a unit test as browser evidence.
