# Affected-feature browser verification and fixes — 0.5.74

Status: **done** — a verification record for 0.5.74; its fixes shipped in that release.

The full browser pass follows the Pi Durable audit and conversation-lifetime
changes in 0.5.71–0.5.72. It uses isolated managed dev members and local MCP
and provider fixtures against the compose stack at localhost:18080. Real
GLM calls verify guide execution and sandbox file operations. Production
is excluded. Detailed screenshots, recordings, and state evidence are in
`guild-audits/pi-durable-2026-10-17/browser/` (outside the repo).

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

## Browser coverage

All **19 affected-feature groups pass** in three isolated Chrome sessions
using two dedicated dev members. The detailed report, screenshots,
recordings, and JSON proofs are in the
[full browser report](guild-audits/pi-durable-2026-10-17/browser/report.md) (outside the repo).

| Group | Terminal evidence |
| --- | --- |
| First touch, streaming, idle | One mapping per chat; partial before completion; partial restored on reload |
| Normal queued follow-up | Stable request IDs, separate answers 16355/16358 |
| Queued steering and attachments | Mobile promotion preserved message and attachment IDs; shared answer 16659; file-only token returned exactly once |
| Withdrawal | No placed entry; echo absent after reload |
| Stop | Active approval and queued input cancelled; next read/history turn worked; in-flight MCP HTTP connection closed |
| Admission cancellation | Delayed discovery cancelled; command cancelled; no durable submission; subsequent turn completed |
| Approvals | Approve, deny, reload, and worker restart preserved intended decisions and original card identities |
| Worker recovery | SIGKILL during pending approval/steer recovered without duplicate events |
| Provider failure | Current error displayed once after reload; existing queued work recovered; older errors hide when superseded as specified |
| Dynamic tools and base history | MCP and org integration fixture calls worked through codemode with history still available |
| Selection and authorization | Disablement during a write approval blocked the later MCP call; empty selection left history callable |
| MCP namespaces | Ambiguous underscore pairs executed distinctly; settings displayed canonical names and invalidated renamed probes |
| MCP draft CRUD | Probe/cancel saved nothing; edits after probe were saved on Add; delete confirmation worked |
| Concurrent users and tracing | Overlapping calls retained correct user/chat/conversation attribution in ClickHouse |
| Skills and guides | Editor create/install/invoke; approved integration cookbook loaded twice; unapproved content withheld |
| Agent publishing and unsafe recovery | v2 publication committed before SIGKILL; recovered tool reported interruption; versions remained exactly v1/v2, no v3 |
| Compaction | Applied summary, no-op, failure/recovery, queued placement, preserved history, and continued model context verified |
| URLs and mobile | Deep links, back/forward, reload and 390-pixel steering verified |
| Browser health | All three contexts ended with empty runtime-error and console-message lists |

For publishing recovery, only the QA user's skill-install row was held.
The registry publication and blob upload completed before the worker was
killed; the nested tool checkpoint was execute/unsafe. Recovery settled the
same task as interrupted without another publication. The row lock was
released, and both fixture versions were subsequently unpublished.

For compaction, task 16634 was terminal while write submission 16635 remained
queued. Both browser and status endpoint stayed running until the held
generation ended; afterward the endpoint returned completed/compacted:true.
A separate short chat returned the true no-op result. A failed compaction
cleared the indicator and a subsequent GLM turn completed. The large-history
chat retained all ten initial event IDs across three summary operations,
rendered its oldest/newest segments after reload, and supplied the latest
summary to the next provider request.

## Completion inventory

The original nine findings and six follow-up correctness findings are
implemented in the linked contract/lifetime plans. Final tests cover
ambiguous commits, first-touch ownership, initialization disposal, worker
readiness/recovery probes and backoff, projection overflow and retry,
unsafe replay, trace isolation, schema checks, and HTTP cancellation.
The browser groups above verify their exposed user flows.

The architecture/style work has matching evidence: bounded worker/boot and
projection-only retirement tests; incremental projection/reconciliation
with persisted identities; per-conversation tool selection and fresh
execution checks; typed registrations and shared serialization; asynchronous
bounded guide extraction and cache checks; a restored full default gate.
Storage diagnostics were exercised live: a QA lifetime committed 30 batches,
measured 4.24 ms aggregate metadata-lock wait and 102.11 ms commit duration,
and reclaimed all 30 positively acknowledged receipts. Ambiguous/crash
residue remains retained by design. No unmeasured protocol/coalescing rewrite
was introduced.

## Final validation and delivery

- Implementation: `82f7c45` and `274bd50`, product **0.5.74** on develop.
- Server typecheck passes. Full final run: **542 server tests across 58
  passing files**, **354 desktop tests across 27 files**, desktop
  TypeScript/Vite build passes. Forty opt-in sandbox checks skipped.
  `bigjob-20261016-233624-guild-v74-tests`, terminal exit 0.
- Canonical compose rebuild/recreation: `bigjob-20261016-233650-guild-v74-deploy`,
  terminal exit 0. Dev health reports 0.5.74; container Pi Durable is 1.3.0.
  Served index-DzEQH9Qv.js matches the image byte for byte: SHA-256
  `e3844f6a90b98a8d03a9b8b6d8f48650b0610f85e7a99184c8b45a0beb7bfc80`.
- Signed desktop packaging/publication: `bigjob-20261016-233651-guild-v74-clients`,
  terminal exit 0. Six artifacts and four local/public dev updater platforms
  advertise 0.5.74. Public Windows installer SHA-256 and Ed25519 verification
  pass: `1feefc590cbce368f43152c049efa1e227adccc346e68a56103cbaca60dd99b0`.
- Final read-only audit: 5,838 projection mappings, zero duplicate pairs;
  zero live tasks and zero recovery backlog. All four QA chats have distinct
  conversation mappings and no pending work.
- Temporary provider/route, integration and MCP rows removed; fixture skills
  uninstalled/unpublished; fixture services stopped and temporary browser
  credentials removed. Dedicated QA members/transcripts remain for review.
- Native Windows/macOS GUI execution was not performed. Browser paths and
  published artifacts were verified. Production untouched.
