# Full review remediation implementation plan

Goal: resolve the 2026-09-23 full review's concrete defects, retain the current public workflows, and deploy the validated result to localhost:18080.

Architecture: preserve the single durable ChatRunner and shared frontend. Tighten trusted executor selection, journal all control-flow decisions, and make outgoing commands and queue consumption durable identities. Keep two subagents active maximum; parent owns integration and deployment.

Spec: docs/reviews/2026-09-23-full/REVIEW.md, docs/PRD.md, docs/SRS.md. Current concurrency baseline ca3420b (0.5.19); preserve other sessions' commits and changes. No commits or client release publishing without authorization. Generated protocol bindings must be regenerated. Tests must use scoped disposable databases; no production mutation as a test. Redeploy via docs/deploy-nuances.md section 2 with live bundle verification. No Superpowers workflow.

## Batch A — server boundary enforcement (server subagent)

Owned files: http/internal.rs, oidc.rs, releases.rs, admin.rs; store/identity.rs, routines.rs; worker/executor.rs, mcp_pool.rs, exec_policy_gate.rs; integrations.rs; exec_policy_base.rules and their tests.

- [x] S0 remove command-wrapper auto-allow; verify `time sh -c ...` prompts.
- [x] S2 prohibit or validate/pin every routine redirect destination.
- [x] S3 require admin authorization for modifications of enabled executable routine config.
- [x] S4/S5/S10 isolate MCP connections by org and identity, evict closed peers, deliver caller/call identity per request.
- [x] S7 bind browser login to a one-time transaction; coordinate App.tsx with parent.
- [x] S8 permit bearer release downloads without mandatory signed-query fields.
- [x] S9 serialize org admin membership changes and count within that transaction.
- [x] S6 coordinate a durable singleton schedule generation with parent-owned routine handler.

Regression seams: exec evaluator, redirect fixture, unauthorized routine PATCH, same MCP URL across orgs, dead peer reconnect, browser login transaction, authenticated unsigned download, concurrent final-admin mutations. Agent reports exact validation; parent runs shared integration suite.

## Batch B — engine, filesystem and provider contracts (engine subagent)

Owned files: app-server machine_link/fs_bridge/cli/agent_start/jsonrpc_loop/artifacts/auth_state; guild-core shell and providers; protocol WS definition and generated files, localized server WS result mapping. Preserve concurrent daemon.rs lifecycle changes.

- [x] S1/S6 reconnect on ordinary backoff; deadline/cancel connect on auth/shutdown.
- [x] S2 bound symlink normalization and return an error on cycles.
- [x] S3/S10 drain bounded shell output and terminate the execution tree on timeout.
- [x] S4 preserve image data across machine result protocol and provider input.
- [x] S5 materialize spilled artifacts on the actual remote execution path.
- [x] S7 initialize identity during headless pair/login.
- [x] S8 match engine project by machine AND folder.
- [x] S9 make CLI paths absolute before daemon RPC.
- [x] S11 fail incomplete SSE EOF in both provider adapters.

Regression seams: backoff zero-time fixture, self-loop symlink, verbose child output, process descendant cleanup, remote image serialization, artifact fetch-then-read, headless auth config, duplicate folder across machines, CLI cwd, truncated provider fixture. No live executor install/restart.

## Batch C — durable workflow (parent)

Files: http/gateway.rs, agents.rs; worker/restate.rs, funnel.rs, turn.rs; store/thread.rs; state.rs and focused tests.

- [x] W1 reject public server_workspace and validate internal workspace paths defensively.
- [x] W2/W3 scope instruction cache by machine/project identity; journal cache selection; bound judge request inside journal.
- [x] W4 track queued user IDs/watermark durably instead of last-event kind.
- [x] W5 account for every provider request through stable IDs.
- [x] W6 stable event IDs and at-most-once/ambiguous-outcome handling for server side effects.
- [x] W7/W8 compact complete tool groups; replace all prior effective summaries.
- [x] W11 gateway deduplicates stable outgoing command identity and returns repeat acknowledgment.

Regression seams: public escape POST, same-path tenants, queued user before prior assistant commit, duplicate invocation/append, tool-group compaction, two compactions, model usage totals. Forced replay requires isolated Restate validation; record limits if unavailable.

## Batch D — frontend command/context integrity (parent then available subagent)

Files: WebChat.tsx, transport.ts, lib/thread-reducer.ts, context.ts, drafts.ts and tests.

- [x] W9 preserve originating/newer drafts on create/submit failures.
- [x] W10 detach immutable attachment snapshot per outgoing command.
- [x] W11 keep command identity across ambiguous retry and reconcile acceptance.
- [x] W12 correct .agents/skills layout and root-to-leaf precedence, platform paths.
- [x] W13 assemble project context on the bound machine; do not substitute sender-local project instructions.
- [x] W14 do not GC from incomplete archived inventory.
- [x] W15 retain every pending command by ID across authoritative rebuilds.

Regression seams: controlled delayed sends/navigation, attachment snapshots, lost response/retry, fixture FS layout, remote machine mismatch, delayed archive list, two queued optimistic sends.

## Batch E — persistence, validation and shipping (parent)

- [x] S1 add persistent Restate volume; preserve the current container's data before any replacement (no empty-volume cutover).
- [x] Run focused regressions and relevant Rust/frontend suites; explicit desktop target check and binding freshness.
- [x] Inspect all diffs and fresh git log/status; reconcile concurrent edits.
- [x] Update PLAN.md decisions and review remediation status with exact remaining limits.
- [x] Run detached compose server rebuild/up recipe and verify health plus changed served asset hash.
- [x] Report deployed server/UI behavior separately from desktop binary changes requiring a future client release.

Pagination and broader product enhancements remain separately recorded in PLAN; do not silently claim them fixed as part of concrete review remediation.

First-batch outcomes: [remediation report](../reviews/2026-09-23-full/REMEDIATION.md). Strict whole-repository lint/format was initially a baseline exception; the continuation below resolves it. This task did not publish client binaries.

## Continuation — remaining recovery and validation gaps

Concurrency baseline is now `ff25bc3`; another session published 0.5.19 clients
from a partially remediated tree. Preserve that release. Continue fixes through
at most two subagents; parent reviews integration and handles deployment.

- [x] Atomic interval starter outbox, permanent singleton claim, lost-response
  recovery, stale/disabled/deleted retirement; verify real forced replay.
- [x] Bound-machine instruction hierarchy, skill discovery/expansion, scoped
  control replies and old-client fallback; verify a real machine socket.
- [x] Immediate artifact prefetch with atomic file publication and first-touch
  recovery; verify concurrent materialization and Windows cross-compilation.
- [x] Account-scoped browser File/Blob and outgoing-command persistence across
  reload, with hydration/sign-out races and mounted-browser evidence.
- [x] Clean strict workspace lint and formatting without blanket suppression.
- [x] Combined integration checks, refreshed reports and PLAN, detached compose
  rebuild/deployment and live health/bundle verification.
